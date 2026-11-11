// End-to-end check of the native binary (no --libnode): fixture URL server + OpenAI-compatible LLM mock.
// usage: node scripts/e2e.mjs <path-to-atento-io-binary> [path-to-atento-browserd.mjs]
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '../../../fixtures/extractors')
const bin = process.argv[2]
const browserd = process.argv[3]
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const llmRequests = []
const enrichment = { category: 'article', priority: 'normal', why_it_matters: 'Mock reason.', read_minutes: 3, action: 'read_now', expires_at: null, expiry_reason: null, confidence: 0.8 }

const pages = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/blog') return res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(join(fixtures, 'blog-post/page.html')))
  if (u.pathname === '/docs') return res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(join(fixtures, 'docs-page/page.html')))
  if (u.pathname === '/hop') return res.writeHead(302, { location: '/hop2' }).end()
  if (u.pathname === '/hop2') return res.writeHead(301, { location: '/blog' }).end()
  if (u.pathname === '/loop') return res.writeHead(302, { location: '/loop' }).end()
  if (u.pathname === '/gone') return res.writeHead(404).end('nope')
  if (u.pathname === '/slow') return setTimeout(() => res.writeHead(200).end('late'), 10000)
  if (u.pathname === '/big') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><article>' + '<p>word </p>'.repeat(2_000_000) + '</article></body></html>')
  if (u.pathname === '/walled') {
    if (!req.headers['sec-ch-ua']) return res.writeHead(403).end('bot wall')
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Walled</title></head><body><div id="r"></div><script>document.getElementById("r").innerHTML="<article><h1>Rendered by JS</h1><p>This paragraph only exists after JavaScript ran in a real browser, and it is long enough to count as content for the extractor test.</p><p>Second paragraph of the walled page, also long enough to be kept by the readable text picker, with commas, and more words.</p></article>"</script></body></html>')
  }
  res.writeHead(404).end()
})
const llm = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    llmRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    if (req.url.endsWith('/chat/completions') && llmRequests.at(-1).body.model === 'boom') return res.writeHead(500).end('upstream down')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(enrichment) } }], usage: { prompt_tokens: 321, completion_tokens: 45 } }))
  })
})
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const pp = await listen(pages)
const lp = await listen(llm)
const env = { ...process.env, OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${lp}/v1`, OPENAI_COMPAT_API_KEY: 'test-key', ATENTO_MODEL: 'mock-model-1' }
const go = async (args, extra = {}) => {
  try { const r = await run(bin, args, { env: { ...env, ...extra }, timeout: 60000, maxBuffer: 1 << 28 }); return { code: 0, out: r.stdout } } catch (e) { return { code: e.code ?? 1, out: e.stdout ?? '' } }
}
let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failed++ }
const base = `http://127.0.0.1:${pp}`

let r = await go(['extract', `${base}/blog`])
let j = JSON.parse(r.out)
check('extract blog: title, markdown, status', j.status === 200 && j.title !== '' && j.markdown.length > 200, `title=${JSON.stringify(j.title)} words=${j.words}`)
r = await go(['extract', `${base}/hop`])
j = JSON.parse(r.out)
check('redirect chain followed (2 hops)', j.finalUrl === `${base}/blog` && j.markdown.length > 200, j.finalUrl)
r = await go(['extract', `${base}/loop`])
j = JSON.parse(r.out)
check('redirect loop stops, needsBrowser', j.needsBrowser === true)
r = await go(['extract', `${base}/gone`])
j = JSON.parse(r.out)
check('404 is final (gone=404)', j.gone === 404 && j.needsBrowser === false)
const t0 = Date.now()
r = await go(['extract', `${base}/slow`], { ATENTO_FETCH_TIMEOUT_MS: '1500' })
j = JSON.parse(r.out)
check('timeout aborts the request', j.needsBrowser === true && Date.now() - t0 < 5000, `${Date.now() - t0}ms`)
r = await go(['extract', `${base}/big`], { ATENTO_FETCH_MAX_BYTES: '100000' })
j = JSON.parse(r.out)
check('size cap truncates at 100 KB without crashing', j.status === 200 && j.words < 9000, `words=${j.words}`)
r = await go(['enrich', `${base}/blog`])
j = JSON.parse(r.out)
check('enrich: structured result parsed', j.ok === true && j.enrichment.category === 'article' && j.tokensIn === 321 && j.tokensOut === 45 && j.modelId === 'mock-model-1', JSON.stringify(j.enrichment))
const q = llmRequests.at(-1)
check('LLM request: path, auth, json_schema, prompt carries extracted text', q.url === '/v1/chat/completions' && q.auth === 'Bearer test-key' && q.body.response_format.type === 'json_schema' && q.body.messages[1].content.includes('Extracted content:'))
r = await go(['enrich', `${base}/blog`], { ATENTO_MODEL: 'boom' })
j = JSON.parse(r.out)
check('enrich: HTTP 500 surfaces as model-stage error', j.ok === false && j.stage === 'model' && j.error.includes('HTTP 500'))
r = await go(['enrich', `${base}/blog`], { ATENTO_MODEL: '' })
check('enrich: missing model env fails loudly (no default model)', r.code !== 0)
if (browserd && existsSync(chrome)) {
  r = await go(['extract', `${base}/walled`], { ATENTO_BROWSERD: browserd, ATENTO_BROWSER_EXECUTABLE: chrome })
  j = JSON.parse(r.out)
  check('403 wall escalates to browserd (real Chrome) and extracts JS-rendered text', j.status === 200 && j.markdown.includes('Rendered by JS'), j.markdown.slice(0, 60))
  r = await go(['extract', `${base}/walled`])
  j = JSON.parse(r.out)
  check('without browserd the wall stays needsBrowser', j.needsBrowser === true)
} else console.log('SKIP browserd checks (no script or Chrome)')
pages.close(); llm.close()
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
