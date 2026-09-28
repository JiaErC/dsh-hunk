/**
 * Print the exact payload the tab renders for one directory.
 *
 * Useful without a browser: it runs the same host route through a fake
 * webserver and prints what came back, so a Hunk CLI change or a session that
 * is not where you think it is shows up here first.
 *
 * Usage: node scripts/preview.mjs [cwd] [--json]
 */
import { HUNK_STATE_PATH, apply } from '../lib/index.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
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
