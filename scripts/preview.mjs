/**
 * Print the exact payload the tab renders for one directory.
 *
 * Useful without a browser: it runs the same host route through a fake
 * webserver and prints what came back, so a Hunk CLI change or a session that
 * is not where you think it is shows up here first.
 *
 * Usage: node scripts/preview.mjs [cwd] [--json] [--patches]
 *
 * `--patches` also runs the on-demand diff read (the one an expanded hunk
 * triggers) and checks that every hunk the tree lists resolves to patch text —
 * the single link a unit test cannot cover without a live window.
 */
import { HUNK_PATCH_PARAM, HUNK_STATE_PATH, apply, pickPatchHunk } from '../lib/index.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const withPatches = args.includes('--patches')
const cwd = args.find(arg => !arg.startsWith('--')) ?? process.cwd()

const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(callback) {
    callback()
    return () => {}
  },
  get() {
    return undefined
  },
}

const originalLog = console.log
console.log = () => {}
try {
  apply(ctx)
} finally {
  console.log = originalLog
}

const route = routes[0]
const res = {
  status: 0,
  body: '',
  writeHead(status) {
    this.status = status
  },
  end(chunk) {
    this.body = String(chunk ?? '')
  },
}

await route.handler(
  { method: 'GET', url: `${HUNK_STATE_PATH}?cwd=${encodeURIComponent(cwd)}`, headers: { host: '127.0.0.1:3080' } },
  res,
)

const body = JSON.parse(res.body)
if (asJson) {
  console.log(JSON.stringify(body, null, 2))
} else if (body.ok === false) {
  console.log(`HTTP ${res.status} ${body.error.code}: ${body.error.message}`)
} else {
  console.log(`cwd        ${body.cwd}`)
  console.log(`sessions   ${body.sessions.length} (matched: ${body.matched === null ? 'none' : body.matched.sessionId})`)
  if (body.otherRepos.length > 0) console.log(`others     ${body.otherRepos.join(', ')}`)
  if (body.review === null) {
    console.log(`review     none — ${body.reviewError?.code}: ${body.reviewError?.message}`)
  } else {
    console.log(`review     ${body.review.title} · ${body.review.files.length} files · ${body.review.reviewNotes.length} notes`)
    for (const file of body.review.files) {
      console.log(`  ${file.path}  +${file.additions} -${file.deletions}  ${file.hunks.length} hunks`)
      for (const hunk of file.hunks) {
        console.log(`    #${hunk.index + 1} ${hunk.header}`)
      }
      for (const note of body.review.reviewNotes.filter(item => item.filePath === file.path)) {
        console.log(`    note(${note.source}) ${note.hunkIndex === undefined ? 'file' : `#${note.hunkIndex + 1}`}: ${note.body.slice(0, 80)}`)
      }
    }
  }
}

if (withPatches) {
  // The same request the tab fires when a hunk is expanded or copied.
  const patchRes = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body = String(chunk ?? '') },
  }
  await route.handler(
    {
      method: 'GET',
      url: `${HUNK_STATE_PATH}?cwd=${encodeURIComponent(cwd)}&${HUNK_PATCH_PARAM}=1`,
      headers: { host: '127.0.0.1:3080' },
    },
    patchRes,
  )
  const patches = JSON.parse(patchRes.body)
  console.log('')
  if (patches.ok === false) {
    console.log(`patches    HTTP ${patchRes.status} ${patches.error.code}: ${patches.error.message}`)
  } else if (patches.error !== null) {
    console.log(`patches    none — ${patches.error.code}: ${patches.error.message}`)
  } else {
    const paths = Object.keys(patches.patches)
    const bytes = paths.reduce((total, path) => total + patches.patches[path].length, 0)
    console.log(`patches    ${paths.length} files · ${bytes} bytes · missing ${patches.missing.length}`)
    const files = body.ok === true && body.review !== null ? body.review.files : []
    let unresolved = 0
    for (const file of files) {
      const text = patches.patches[file.path]
      const sizes = file.hunks.map((hunk) => {
        const slice = pickPatchHunk(text, hunk)
        if (slice === undefined) unresolved += 1
        return `${hunk.index + 1}:${slice === undefined ? 'MISSING' : `${slice.lines.length}L`}`
      })
      console.log(`  ${file.path}  ${text === undefined ? 'no patch' : `${text.length}B`}  hunks ${sizes.join(' ')}`)
    }
    if (files.length > 0) {
      console.log(unresolved === 0
        ? 'check      every listed hunk resolves to patch text ✔'
        : `check      ${unresolved} hunk(s) have no patch text ✖`)
    }
  }
}
