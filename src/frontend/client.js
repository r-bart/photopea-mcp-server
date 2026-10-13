(function () {
  'use strict';
  const PROTOCOL = 2, CHUNK = 1024 * 1024, MAX_BYTES = 512 * 1024 * 1024;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const sessionId = crypto.randomUUID();
  const iframe = document.getElementById('photopea');
  const status = document.getElementById('status-text');
  const dot = document.getElementById('status-dot');
  let ws, epoch, ready = false, authenticated = false, pending = null, upload = null, download = null;
  let reconnectDelay = 1000, reconnectTimer, entries = 0;
  document.getElementById('log-header').addEventListener('click', () => document.getElementById('log-panel').classList.toggle('collapsed'));
  function log(tool, text, error) {
    document.getElementById('log-empty')?.remove();
    const entry = document.createElement('div'); entry.className = 'log-entry ' + (error ? 'entry-err' : 'entry-ok');
    const title = document.createElement('span'); title.className = 'log-tool'; title.textContent = tool;
    const body = document.createElement('span'); body.className = 'log-summary'; body.textContent = text;
    entry.append(title, body);
    const list = document.getElementById('log-entries'); list.appendChild(entry);
    if (++entries > 100) { list.firstChild.remove(); entries--; }
    document.getElementById('log-count').textContent = entries + ' entries'; list.scrollTop = list.scrollHeight;
  }
  function send(msg) {
    if (authenticated && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...msg, sessionId, epoch }));
  }
  function editor(payload) { iframe.contentWindow.postMessage(payload, 'https://www.photopea.com'); }
  async function sha256(buffer) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
  }
  function connect() {
    ws = new WebSocket('ws://' + location.host + '/'); ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, sessionId, ready }));
    };
    ws.onclose = event => {
      authenticated = false; epoch = undefined; upload = null;
      dot.classList.remove('connected'); status.textContent = 'Disconnected — editor preserved';
      if (event.code === 1008) { status.textContent = event.reason + ' — use the owning tab'; return; }
      reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };
    ws.onerror = () => {};
    let messages = Promise.resolve();
    ws.onmessage = event => {
      messages = messages.then(() => handle(event.data)).catch(error => {
        log('protocol', error.message, true);
        // A protocol fault cannot establish editor completion.
        send({ type: 'status', ready: false });
      });
    };
  }
  async function handle(data) {
    if (data instanceof ArrayBuffer) {
      if (!download || data.byteLength <= 8) throw new Error('Unexpected load chunk');
      const header = new DataView(data);
      const n = data.byteLength - 8;
      if (header.getUint32(0) !== download.sequence || header.getUint32(4) !== download.offset || n > CHUNK || download.offset + n > download.bytes.length) throw new Error('Invalid load chunk');
      download.bytes.set(new Uint8Array(data, 8), download.offset); download.offset += n; download.sequence++;
      send({ type: 'load_ack', id: pending.id, offset: download.offset }); return;
    }
    const msg = JSON.parse(data);
    if (msg.type === 'welcome') {
      if (msg.protocol !== PROTOCOL || msg.sessionId !== sessionId) throw new Error('Incompatible bridge');
      epoch = msg.epoch; authenticated = true; reconnectDelay = 1000;
      dot.classList.add('connected'); status.textContent = ready ? 'Connected — Photopea ready' : 'Waiting for Photopea';
      if (msg.activeId && (!pending || pending.id !== msg.activeId)) {
        status.textContent = 'Unknown operation — inspect editor; queue retained'; return;
      }
      if (!msg.activeId && pending) pending = null; // Server already persisted a result before losing ACK.
      if (pending?.finished) await report();
      return;
    }
    if (!authenticated || msg.sessionId !== sessionId || msg.epoch !== epoch) return;
    if (msg.type === 'activity') { log(msg.tool, msg.summary, false); return; }
    if (msg.type === 'settled') { if (pending?.id === msg.id) { pending = null; upload = null; } return; }
    if (msg.type === 'transfer_error') {
      upload = null;
      status.textContent = 'Transfer failed — operation retained';
      log('export', msg.error, true);
      // File/done have arrived: explicitly confirm execution ended, but artifact failed.
      if (pending?.finished) send({ type: 'result', id: pending.id, success: false, data: null, error: msg.error });
      return;
    }
    if (msg.type === 'execute') {
      if (pending) throw new Error('Editor already owned');
      pending = { id: msg.id, echoes: [], file: null, expectFiles: msg.expectFiles, ended: false, finished: false, error: null, kind: 'script' };
      log('execute', msg.id + (msg.expectFiles ? ' — export' : ' — script'), false);
      // The live interpreter does not implement eval/try/finally like browser JS.
      // A runtime error without this suffix retains ownership as indeterminate.
      const begin = '__mcp_begin:' + msg.id, end = '__mcp_end:' + msg.id;
      editor('app.echoToOE(' + JSON.stringify(begin) + ');\n' + msg.script + '\n;app.echoToOE(' + JSON.stringify(end) + ');');
      return;
    }
    if (msg.type === 'load_begin') {
      if (pending || !Number.isSafeInteger(msg.byteLength) || msg.byteLength < 1 || msg.byteLength > MAX_BYTES || !/^[a-f0-9]{64}$/.test(msg.sha256)) throw new Error('Invalid load manifest');
      pending = { id: msg.id, kind: 'load', echoes: [], file: null, finished: false, ended: false, error: null };
      download = { bytes: new Uint8Array(msg.byteLength), offset: 0, sequence: 0, sha256: msg.sha256 };
      send({ type: 'load_ack', id: msg.id, offset: 0 }); return;
    }
    if (msg.type === 'load_end') {
      if (!download || pending?.id !== msg.id || download.offset !== download.bytes.length) throw new Error('Incomplete load');
      const buffer = download.bytes.buffer;
      if (await sha256(buffer) !== download.sha256) throw new Error('Load checksum mismatch');
      download = null;
      pending.ended = true;
      editor(buffer); return;
    }
    if (msg.type === 'file_ack') {
      if (!upload || pending?.id !== msg.id || msg.offset !== upload.offset) throw new Error('Invalid file ACK');
      if (upload.offset === pending.file.byteLength) {
        send({ type: 'file_end', id: pending.id }); upload = null; return;
      }
      const n = Math.min(CHUNK, pending.file.byteLength - upload.offset);
      const chunk = new Uint8Array(8 + n), view = new DataView(chunk.buffer);
      view.setUint32(0, upload.sequence++); view.setUint32(4, upload.offset);
      chunk.set(new Uint8Array(pending.file, upload.offset, n), 8);
      upload.offset += n; ws.send(chunk); return;
    }
  }
  async function report() {
    if (!authenticated || !pending?.finished || pending.reporting) return;
    const operation = pending; operation.reporting = true;
    try {
    if (pending.error) { send({ type: 'result', id: pending.id, success: false, data: null, error: pending.error }); return; }
    if (pending.file) {
      if (!pending.expectFiles) { send({ type: 'result', id: pending.id, success: false, data: null, error: 'Unexpected binary export in a script operation' }); return; }
      if (!pending.sha256) pending.sha256 = await sha256(pending.file);
      if (!authenticated || pending !== operation) return;
      upload = { offset: 0, sequence: 0 };
      send({ type: 'file_begin', id: pending.id, byteLength: pending.file.byteLength, sha256: pending.sha256 });
    } else {
      send({ type: 'result', id: pending.id, success: !pending.expectFiles, data: pending.echoes.join('\n') || null, error: pending.expectFiles ? 'Export ended without binary artifact' : null });
    }
    } finally { operation.reporting = false; }
  }
  window.addEventListener('message', event => {
    if (event.source !== iframe.contentWindow || event.origin !== 'https://www.photopea.com') return;
    const data = event.data;
    if (!ready) {
      if (data !== 'done') return;
      ready = true; status.textContent = authenticated ? 'Connected — Photopea ready' : 'Photopea ready — connecting';
      send({ type: 'status', ready: true }); return;
    }
    if (!pending || pending.finished) return;
    if (data instanceof ArrayBuffer) {
      if (pending.file) pending.error = 'Multiple exports are unsupported in one operation';
      else pending.file = data;
    } else if (typeof data === 'string') {
      if (data === '__mcp_begin:' + pending.id) { pending.began = true; log('execution', 'Begin received', false); }
      else if (data === '__mcp_end:' + pending.id) { pending.ended = true; log('execution', 'End received', false); }
      else if (data.startsWith('__mcp_error:' + pending.id + ':')) pending.error = data.slice(('__mcp_error:' + pending.id + ':').length);
      else if (data === 'done') {
        log('execution', pending.ended ? 'Done after tagged end' : 'Done without tagged end — ownership retained', !pending.ended);
        if (pending.ended) { pending.finished = true; report().catch(e => { log('export', e.message, true); send({ type: 'status', ready: false }); }); }
      } else if (pending.echoes.join('\n').length + data.length <= 128 * 1024) pending.echoes.push(data);
      else pending.error = 'Echo result exceeds budget';
    }
  });
  // Retain the iframe and its pending result across a socket reconnect.
  status.textContent = token ? 'Connecting to isolated bridge' : 'Missing launch credential — open through MCP';
  if (token) connect();
}());
