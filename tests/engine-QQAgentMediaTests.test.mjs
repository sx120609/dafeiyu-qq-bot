// The agent's QQ tools for files, voice, video, 合并转发, pictures and members (engine/QQAgentMedia.mjs), and how
// every kind of segment SnowLuma delivers reads in the timeline. A scripted director against the in-process OneBot
// fixture; downloads and the gateway are fetch stubs. Nothing here talks to QQ, the gateway or a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as XLSX from 'xlsx';
import {OneBotFixture, ModelScript, tempDirectory, removeDirectory, wait, call, results, opening} from './engine-fixtures.mjs';
import {QQEngine} from '../engine/QQEngine.mjs';
import {DeepSeekClient} from '../engine/Services.mjs';
import {QQPolicy} from '../engine/core/QQPolicy.mjs';
import {QQGroupNotice} from '../engine/core/QQGroupNotice.mjs';
import {QQMemoryBook} from '../engine/core/QQMemoryBook.mjs';
import {QQFileText} from '../engine/QQFileText.mjs';
import {QQVoice} from '../engine/QQVoice.mjs';
import {QQComputer} from '../engine/QQComputer.mjs';
import {QQCustomTools} from '../engine/QQCustomTools.mjs';

// MARK: Test data

/** A zip with stored-or-deflated entries, as Office writes them. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), packed = zlib.deflateRawSync(raw), title = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(title.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(title.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, title, packed); centrals.push(central, title);
    offset += 30 + title.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const docx = paragraphs => zip({'[Content_Types].xml': '<Types/>', 'word/document.xml':
  '<w:document><w:body>' + paragraphs.map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>'});
function examWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['期末考试安排'],
    ['课程', '教室', '考试时间', '人数'],
    ['高等数学', null, 46362 + 9 / 24, 0],
    [],
    ['大学英语', 'A101', 46363 + 14.5 / 24, 32]
  ]);
  sheet.C3.z = sheet.C5.z = 'yyyy-mm-dd hh:mm';
  sheet['!merges'] = [XLSX.utils.decode_range('A1:D1')];
  XLSX.utils.book_append_sheet(workbook, sheet, '考试安排');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['备注'], ['提前十五分钟到场']]), '注意事项');
  return XLSX.write(workbook, {type: 'buffer', bookType: 'biff8', bookSST: true});
}
/** A one-page PDF with a line of text, offsets computed so any reader takes it. */
function pdf(line) {
  const content = `BT /F1 24 Tf 40 60 Td (${line}) Tj ET`;
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('');
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
/** A 2x2 PNG, real enough for Pillow. */
function png() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const pixels = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

// MARK: Rig

/** The director calls `steps` (each [tool, args] or a function of the results so far) in order, then ends with "done". */
async function rig(steps, {shape = 'group', vision = false} = {}) {
  const directory = tempDirectory();
  const fixture = await new OneBotFixture({shape: 'group'}).start();
  const seen = {results: [], operator: []};
  const model = new ModelScript((purpose, messages, body) => {
    if (purpose !== 'director') { seen.operator.push(body); return {content: '助手看到：一只蓝色的鲸鱼'}; }
    const so = results(messages);
    seen.results = so; seen.opening = opening(messages);
    const step = steps[so.length];
    if (!step) return {content: 'done'};
    const [name, args] = typeof step === 'function' ? step(so, seen) : step;
    return call(name, args);
  });
  const engine = new QQEngine({allowAuthenticationUI: false, storageDirectory: directory, modelClient: new DeepSeekClient({session: model.session})});
  engine.config.endpoint = fixture.endpoint; engine.config.expectedSelfID = '12345';
  engine.config.effectiveVisionEnabled = vision; engine.config.effectivePersona.stickersEnabled = false;
  engine.config.ai.cooldownSeconds = 1; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1;
  engine.agentQuietSeconds = 0.4; engine.agentCollectSeconds = 2;
  // Downloads: a map of URL → bytes.
  const web = {};
  engine.mediaSession = async url => {
    const body = web[url];
    return body === undefined ? new Response('missing', {status: 404}) : new Response(body, {status: 200, headers: {'Content-Length': String(body.length)}});
  };
  assert.ok(engine.useTemporaryCredentials('synthetic-test-token', 'synthetic-key'));
  await engine.connect(); assert.ok(engine.connected, engine.error ?? engine.status);
  engine.add(engine.contacts.find(contact => shape === 'private' ? contact.number === '54321' && !contact.group : contact.number === '99999'));
  engine.config.targets[0].enabled = true;
  engine.start();
  return {directory, fixture, model, engine, web, seen,
    finished: () => wait(() => engine.agentTurns[0]?.note === 'done', 15),
    stop: async () => { engine.pause(); engine.disconnect(); await fixture.stop(); removeDirectory(directory); }};
}
const group = (id, sender, message) => ({post_type: 'message', self_id: 12345, user_id: sender, sender: {user_id: sender, card: `群友${sender}`}, message_type: 'group',
  sub_type: 'normal', group_id: 99999, message_id: id, message: typeof message === 'string' ? [{type: 'text', data: {text: message}}] : message});
const friend = (id, text) => ({post_type: 'message', self_id: 12345, user_id: 54321, sender: {user_id: 54321}, message_type: 'private',
  sub_type: 'friend', message_id: id, message: [{type: 'text', data: {text}}]});
const stored = (id, segments, sender = 54321) => ({message_id: id, message_type: 'group', group_id: 99999, sender: {user_id: sender, card: `群友${sender}`}, message: segments});
const label = number => QQMemoryBook.subject('12345', 'group:99999', number);

// MARK: Incoming formats

const parse = message => QQPolicy.incoming({post_type: 'message', self_id: 12345, user_id: 54321, message_type: 'private', sub_type: 'friend',
  message_id: 7, time: 1000, message, sender: {user_id: 54321}}, '12345', 990, 1001);

test('everySegmentKindReadsInTheTimeline', () => {
  const card = value => ({type: 'json', data: {data: JSON.stringify(value)}});
  const message = [
    {type: 'text', data: {text: '看看'}},
    card({app: 'com.tencent.miniapp_01', prompt: '[QQ小程序]哔哩哔哩', meta: {detail_1: {appid: '1', title: '哔哩哔哩', desc: '会开门的猫', qqdocurl: 'https://b23.tv/x'}}}),
    card({app: 'com.tencent.structmsg', view: 'music', meta: {music: {title: '晴天', desc: '周杰伦', jumpUrl: 'https://y.qq.com/s', tag: 'QQ音乐'}}}),
    card({app: 'com.tencent.multimsg', meta: {detail: {news: [{text: '甲：开会'}], source: '群聊的聊天记录', resid: 'RES-1'}}}),
    {type: 'xml', data: {data: '<msg serviceID="1" url="https://a.example/1"><item><title>标题</title><summary>摘要</summary></item></msg>'}},
    {type: 'file', data: {file: '课表.xlsx', file_id: 'F-1', file_size: 20480, name: '课表.xlsx'}},
    {type: 'record', data: {file: 'v.amr', url: 'https://example.invalid/v'}},
    {type: 'video', data: {file: 'clip.mp4', url: 'https://example.invalid/c'}},
    {type: 'forward', data: {id: 'RES-2'}},
    {type: 'markdown', data: {content: '**粗体**'}}, {type: 'text', data: {text: '**粗体**'}},
    {type: 'face', data: {id: '358', resultId: '4'}}, {type: 'face', data: {id: '359', resultId: '2'}},
    {type: 'image', data: {file: 'f.jpg', url: 'https://gchat.qpic.cn/f', type: 'flash'}},
    {type: 'poke', data: {type: 1}},
    {type: 'flash_file', data: {title: '大文件.zip', file_set_id: 'FS-1'}},
    {type: 'inline_keyboard', data: {rows: [{buttons: [{label: '签到'}, {label: '帮助'}]}]}}
  ];
  const incoming = parse(message);
  for (const part of ['看看', '[QQ小程序·哔哩哔哩：会开门的猫｜https://b23.tv/x]', '[分享音乐·QQ音乐：晴天 - 周杰伦｜https://y.qq.com/s]',
    '[合并转发的聊天记录：群聊的聊天记录（甲：开会），要看全文用 read_forward]', '[分享链接：标题｜摘要｜https://a.example/1]',
    '[文件：课表.xlsx（20 KB），要读用 read_file]', '[语音，要听用 listen_voice]', '[视频，要看用 watch_video]',
    '[Markdown 消息：**粗体**]', '[掷骰子：4 点]', '[猜拳：剪刀]', '[闪照]', '[戳一戳]', '[闪传文件：大文件.zip，要读用 read_file]', '[按钮：签到｜帮助]']) {
    assert.ok(incoming.text.includes(part), part + ' in ' + incoming.text);
  }
  // The markdown's repeated text segment is not shown twice.
  assert.equal(incoming.text.split('**粗体**').length, 2);
  assert.deepEqual(incoming.media.map(item => item.kind), ['forward', 'file', 'record', 'video', 'forward', 'flash_file']);
  assert.equal(incoming.media[0].id, 'RES-1');
  assert.equal(incoming.media[1].file_id, 'F-1');
  // Unknown apps still show what the card says; a group file upload names the tool and the file id.
  assert.equal(QQPolicy.placeholder('json', {data: JSON.stringify({app: 'x.y', prompt: '[新玩意]', meta: {a: {b: {title: '深处的标题'}}}})}), '[卡片·[新玩意]：深处的标题]');
  const upload = QQGroupNotice.describe({post_type: 'notice', notice_type: 'group_upload', group_id: 99999, user_id: 54321,
    file: {id: '/abc', name: '报告.pdf', size: 3145728, busid: 102}}, '12345', 'group:99999');
  assert.equal(upload, `${label('54321')} 上传了群文件「报告.pdf」（3 MB），要读用 read_file，file_id 填 /abc`);
});

test('fileTextComesOutOfOfficeFilesPdfAndText', async () => {
  const directory = tempDirectory();
  try {
    const word = await QQFileText.extract(docx(['第一段', '第二段 &amp; 结尾']), '说明.docx', directory);
    assert.equal(word.text, '第一段\n第二段 & 结尾');
    const sheet = await QQFileText.extract(zip({'xl/workbook.xml': '<workbook><sheets><sheet name="成绩" r:id="r1"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>分数</v></c></row><row><c t="s"><v>1</v></c><c><v>95</v></c></row></sheetData></worksheet>'}), '成绩.xlsx', directory);
    assert.equal(sheet.text, '【工作表 成绩】\n姓名\t分数\n张三\t95');
    const slides = await QQFileText.extract(zip({'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>'}), 'x.pptx', directory);
    assert.equal(slides.text, '【第 1 页】\n封面\n\n【第 2 页】\n第二页');
    const gbk = await QQFileText.extract(Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]), 'old.txt', directory);
    assert.equal(gbk.text, '你好');
    const listing = await QQFileText.extract(zip({'a/b.txt': 'x'}), 'pack.zip', directory);
    assert.ok(listing.text.includes('a/b.txt') && listing.note.includes('压缩包'));
    assert.equal((await QQFileText.extract(png(), 'shot.png', directory)).kind, 'image');
    const paper = await QQFileText.extract(pdf('Hello PDF'), 'paper.pdf', directory);
    if (paper.kind === 'unknown' && paper.note.includes('pdftotext')) return; // Poppler not installed here
    assert.equal(paper.kind, 'text');
    assert.ok(paper.text.includes('Hello PDF'), paper.text);
  } finally { removeDirectory(directory); }
});

// MARK: Files

test('readsBinaryExcelRowsWithTheirExamTimes', async () => {
  const data = examWorkbook();
  assert.equal(data.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  const directory = tempDirectory();
  try {
    const result = await QQFileText.extract(data, '考试安排.xls', directory);
    assert.equal(result.kind, 'text');
    assert.ok(result.text.includes('高等数学\t\t2026-12-06 09:00\t0'), result.text);
    assert.ok(result.text.includes('\n\t\t\t\n大学英语\tA101\t2026-12-07 14:30\t32'), result.text);
    assert.ok(result.text.includes('【工作表 考试安排】'), result.text);
    assert.ok(result.text.includes('合并单元格：A1:D1'), result.text);
    assert.ok(result.text.includes('【工作表 注意事项】\n'), result.text);
    assert.ok(result.text.includes('提前十五分钟到场'), result.text);
    assert.equal(result.note, undefined);
    assert.deepEqual(await QQFileText.extract(data, 'download', directory), result);
  } finally { removeDirectory(directory); }
});

test('readFileReturnsBinaryExcelCellsFromAMessage', async () => {
  const r = await rig([['read_file', {message: '203'}]]);
  try {
    r.fixture.messages['203'] = stored(203, [{type: 'file', data: {file_id: 'f-203', name: '考试安排.xls'}}]);
    r.fixture.fileURLs['f-203'] = 'https://files.example/exams';
    r.web['https://files.example/exams'] = examWorkbook();
    r.fixture.inject([group(1, 54321, '@大肥鱼 看看考试安排')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [text] = r.seen.results;
    assert.ok(text.includes('文件「考试安排.xls」'), text);
    assert.ok(text.includes('高等数学\t\t2026-12-06 09:00\t0'), text);
    assert.ok(text.includes('大学英语\tA101\t2026-12-07 14:30\t32'), text);
    assert.ok(!text.includes('按字节粗提'), text);
  } finally { await r.stop(); }
});

test('readsBinaryExcelSharedStringsAcrossRecords', async () => {
  const rows = Array.from({length: 300}, (_, index) => [`课程${index}：${'复习'.repeat(50)}`, null, `考试场次${index}`]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '课程表');
  const data = XLSX.write(workbook, {type: 'buffer', bookType: 'biff8', bookSST: true});
  assert.ok(data.length > 62500);
  const directory = tempDirectory();
  try {
    const result = await QQFileText.extract(data, '课程表.xls', directory);
    assert.equal(result.kind, 'text');
    assert.deepEqual(result.text.split('\n').slice(2), rows.map(row => row.join('\t')));
  } finally { removeDirectory(directory); }
});

test('brokenBinaryExcelReportsAParseErrorInsteadOfByteRuns', async () => {
  const directory = tempDirectory();
  try {
    const result = await QQFileText.extract(examWorkbook().subarray(0, 64), 'broken.xls', directory);
    assert.equal(result.kind, 'unknown');
    assert.ok(result.note.includes('Excel 工作簿打不开'), result.note);
    assert.equal(result.text, undefined);
  } finally { removeDirectory(directory); }
});

test('readsSentFilesAndGroupFilesInChunks', async () => {
  const long = 'x'.repeat(25000) + '结尾';
  const r = await rig([
    ['read_file', {message: '201'}],
    ['list_group_files', {}],
    ['read_file', {file_id: '/doc-1'}],
    ['read_file', {message: '202'}],
    ['read_file', {message: '202', offset: 20000}]
  ]);
  try {
    r.fixture.messages['201'] = stored(201, [{type: 'file', data: {file: '通知.txt', file_id: 'f-201', file_size: 30, name: '通知.txt'}}]);
    r.fixture.fileURLs['f-201'] = 'https://files.example/201';
    r.web['https://files.example/201'] = Buffer.from('明天下午三点开会，带电脑。');
    r.fixture.groupFiles['/'] = {folders: [{folder_id: '/fold', folder_name: '资料', total_file_count: 3}],
      files: [{file_id: '/doc-1', file_name: '说明.docx', file_size: 4096, uploader: 54321, uploader_name: '群友54321', upload_time: 1700000000, busid: 102, download_times: 5}]};
    r.fixture.fileURLs['/doc-1'] = 'https://files.example/doc';
    r.web['https://files.example/doc'] = docx(['群规第一条：不许刷屏']);
    // A file message the bot saw come in (QQ's own copy is not needed for it).
    r.fixture.fileURLs['f-202'] = 'https://files.example/202';
    r.web['https://files.example/202'] = Buffer.from(long);
    r.fixture.inject([group(202, 54321, [{type: 'file', data: {file: 'long.txt', file_id: 'f-202', file_size: long.length, name: 'long.txt'}}])]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [sent, listing, word, first, second] = r.seen.results;
    assert.ok(sent.includes('文件「通知.txt」') && sent.includes('明天下午三点开会'), sent);
    assert.ok(listing.includes('[文件夹] 资料（3 个文件）folder=/fold') && listing.includes('说明.docx｜4 KB｜群友54321 传的') && listing.includes('file_id=/doc-1'), listing);
    assert.ok(word.includes('文件「说明.docx」（4 KB）') && word.includes('群规第一条：不许刷屏'), word);
    assert.ok(first.includes('offset 填 20000') && !first.includes('结尾'), first.slice(-200));
    assert.ok(second.includes('结尾') && second.includes('第 20001–25002 字'), second.slice(-200));
    assert.ok(r.seen.opening.includes('[文件：long.txt（24.4 KB），要读用 read_file]'));
    assert.ok(r.fixture.calls.some(item => item.action === 'get_group_file_url' && item.params.file_id === '/doc-1' && item.params.busid === 102));
  } finally { await r.stop(); }
});

test('sendsFilesItWritesOrDownloads', async () => {
  let written;
  const r = await rig([
    ['send_file', {name: '名单.csv', text: '名字,分数\n张三,95', caption: '整理好了'}],
    (so, seen) => { written = r.fixture.payloads.at(-1)?.message?.[0]?.data; return ['send_file', {url: 'https://files.example/report.pdf'}]; },
    ['send_file', {message: '201'}]
  ]);
  try {
    r.web['https://files.example/report.pdf'] = pdf('report');
    r.fixture.messages['201'] = stored(201, [{type: 'file', data: {file: '原件.txt', file_id: 'f-201', name: '原件.txt'}}]);
    r.fixture.fileURLs['f-201'] = 'https://files.example/201';
    r.web['https://files.example/201'] = Buffer.from('原件内容');
    r.fixture.inject([group(1, 54321, '@大肥鱼 把名单发个文件')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const segments = r.fixture.segments();
    assert.deepEqual(segments[0], ['text:整理好了']);
    assert.equal(r.fixture.payloads[1].message[0].type, 'file');
    assert.equal(written.name, '名单.csv');
    // The file is written to the engine's own folder and handed to SnowLuma by path, UTF-8 with a BOM for Excel.
    assert.ok(written.file.startsWith(r.directory) && fs.readFileSync(written.file).equals(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('名字,分数\n张三,95')])));
    assert.equal(r.fixture.payloads[2].message[0].data.name, 'report.pdf');
    assert.equal(r.fixture.payloads[3].message[0].data.name, '原件.txt');
    assert.ok(r.seen.results.every(result => result.includes('发了文件')), JSON.stringify(r.seen.results));
    assert.ok(r.engine.agentTurns[0].sent.includes('发了文件「名单.csv」'));
  } finally { await r.stop(); }
});

// MARK: Forwards

test('readsNestedForwardsAndSendsOne', async () => {
  const r = await rig([
    ['read_forward', {message: '301'}],
    ['send_forward', {title: '今天的新闻', messages: [{text: '第一条：降温了'}, {text: '第二条：放假', name: '新闻姬'}, {message: '301'}]}]
  ]);
  try {
    r.fixture.messages['301'] = stored(301, [{type: 'forward', data: {id: 'res-a'}}]);
    r.fixture.forwards['res-a'] = [
      {sender: {user_id: 1, nickname: '甲'}, time: 1700000000, message: [{type: 'text', data: {text: '周五聚餐'}}]},
      {sender: {user_id: 2, nickname: '乙'}, time: 1700000060, message: [{type: 'text', data: {text: '看这个'}}, {type: 'forward', data: {id: 'res-b'}}]}];
    r.fixture.forwards['res-b'] = [{sender: {user_id: 3, card: '丙'}, message: [{type: 'text', data: {text: '里面那层'}},
      {type: 'json', data: {data: JSON.stringify({app: 'com.tencent.structmsg', view: 'news', meta: {news: {title: '一篇文章', jumpUrl: 'https://n.example'}}})}}]}];
    r.fixture.inject([group(1, 54321, '@大肥鱼 这个转发说了啥')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [read, sent] = r.seen.results;
    assert.ok(read.includes('合并转发的聊天记录（2 条') && /\] 甲：周五聚餐/.test(read) && read.includes('乙：看这个[又一层合并转发]'), read);
    assert.ok(read.includes('  ↳ 丙：里面那层[分享链接：一篇文章｜https://n.example]'), read);
    const payload = r.fixture.forwardPayloads[0];
    assert.equal(payload.action, 'send_group_forward_msg');
    assert.equal(String(payload.params.group_id), '99999');
    assert.equal(payload.params.source, '今天的新闻');
    assert.deepEqual(payload.params.messages.map(node => node.type), ['node', 'node', 'node']);
    assert.deepEqual(payload.params.messages[0].data, {user_id: '12345', nickname: '大肥鱼', content: [{type: 'text', data: {text: '第一条：降温了'}}]});
    assert.equal(payload.params.messages[1].data.nickname, '新闻姬');
    assert.deepEqual(payload.params.messages[2].data, {id: '301'});
    assert.ok(sent.includes('发了一条合并转发（3 段'), sent);
    assert.equal(r.engine.sends.confirmed, 1);
  } finally { await r.stop(); }
});

// MARK: Voice and video

test('voiceIsTranscribedOrSaysWhyNot', async () => {
  const previous = {url: process.env.DAFEIYU_CODEX_URL, voice: QQVoice.session, computer: QQComputer.session, tools: QQCustomTools.session};
  process.env.DAFEIYU_CODEX_URL = 'http://127.0.0.1:9/v1';
  const asked = [];
  let keyMissing = false;
  const gateway = async (url, init = {}) => {
    if (url.endsWith('/audio/transcriptions')) {
      asked.push(JSON.parse(String(init.body)));
      return keyMissing ? new Response(JSON.stringify({error: '听语音要用 OpenAI 的 Key'}), {status: 400}) : new Response(JSON.stringify({text: '今晚吃火锅'}), {status: 200});
    }
    return new Response('{}', {status: 404});
  };
  QQVoice.session = gateway; QQComputer.session = gateway; QQCustomTools.session = gateway;
  const r = await rig([
    ['listen_voice', {message: '401'}],
    (so) => { r.fixture.pttText = 'QQ 自己听出来的'; return ['listen_voice', {message: '401'}]; },
    (so) => { r.fixture.pttText = undefined; keyMissing = true; return ['listen_voice', {message: '401'}]; }
  ]);
  try {
    r.fixture.messages['401'] = stored(401, [{type: 'record', data: {file: 'v401.amr', url: ''}}]);
    r.fixture.records['v401.amr'] = {mp3: Buffer.from('fake-mp3').toString('base64')};
    r.fixture.inject([group(1, 54321, '@大肥鱼 听听我的语音')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [heard, qq, refused] = r.seen.results;
    assert.ok(heard.includes('语音转文字') && heard.includes('今晚吃火锅'), heard);
    assert.deepEqual(asked[0], {audio: Buffer.from('fake-mp3').toString('base64'), format: 'mp3'});
    assert.ok(qq.includes('QQ 自带识别') && qq.includes('QQ 自己听出来的'), qq);
    assert.ok(refused.includes('转不了文字') && refused.includes('OpenAI 的 Key'), refused);
    assert.ok(r.fixture.calls.some(item => item.action === 'get_record' && item.params.out_format === 'mp3'));
  } finally {
    await r.stop();
    if (previous.url === undefined) delete process.env.DAFEIYU_CODEX_URL; else process.env.DAFEIYU_CODEX_URL = previous.url;
    QQVoice.session = previous.voice; QQComputer.session = previous.computer; QQCustomTools.session = previous.tools;
  }
});

test('videoFramesGoToTheHelper', async () => {
  const previous = {frames: QQFileText.videoFrames, audio: QQFileText.audioTrack};
  let looked;
  QQFileText.videoFrames = async file => { looked = fs.readFileSync(file); return {duration: 12.4, frames: [Buffer.from('jpeg-1'), Buffer.from('jpeg-2')]}; };
  QQFileText.audioTrack = async () => undefined;
  const r = await rig([['watch_video', {message: '501', question: '猫在干嘛'}], ['watch_video', {message: '502'}]], {vision: true});
  try {
    r.fixture.messages['501'] = stored(501, [{type: 'video', data: {file: 'cat.mp4', url: 'https://video.example/cat'}}]);
    r.web['https://video.example/cat'] = Buffer.from('fake-video');
    r.fixture.messages['502'] = stored(502, [{type: 'text', data: {text: '只是字'}}]);
    r.fixture.inject([group(1, 54321, '@大肥鱼 看我家猫')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [video, none] = r.seen.results;
    assert.ok(video.includes('约 12 秒') && video.includes('2 帧') && video.includes('一只蓝色的鲸鱼'), video);
    assert.equal(looked.toString(), 'fake-video');
    const operator = JSON.parse(r.seen.operator.at(-1));
    const parts = operator.messages.at(-1).content;
    assert.ok(parts.some(part => part.type === 'text' && part.text.includes('猫在干嘛')));
    assert.equal(parts.filter(part => part.type === 'image_url').length, 2);
    assert.ok(none.includes('没有视频'), none);
  } finally { await r.stop(); QQFileText.videoFrames = previous.frames; QQFileText.audioTrack = previous.audio; }
});

// MARK: Pictures and people

test('findsMembersAvatarsCardsAndHonors', async () => {
  const quiet = label('70001');
  const r = await rig([
    ['find_member', {query: '小明'}],
    ['poke', {member: quiet}],
    ['look_at_avatar', {member: quiet}],
    ['send_image', {avatar: 'GROUP', caption: '群头像'}],
    ['set_my_card', {card: '鲸鱼'}],
    ['group_info', {what: 'basic'}]
  ], {vision: true});
  try {
    r.fixture.memberList = [
      {group_id: 99999, user_id: 70001, nickname: 'xm', card: '小明同学', role: 'member', title: '潜水王', level: '3', last_sent_time: 1600000000},
      {group_id: 99999, user_id: 70002, nickname: '小红', card: '', role: 'admin'},
      {group_id: 99999, user_id: 12345, nickname: '大肥鱼', card: ''}];
    r.fixture.honor = {group_id: 99999, current_talkative: {user_id: 70002, nickname: '小红', avatar: '', description: '连续 3 天'},
      talkative_list: [], performer_list: [{user_id: 70001, nickname: 'xm', avatar: '', description: ''}], legend_list: [], emotion_list: [], strong_newbie_list: []};
    r.web['https://q.qlogo.cn/headimg_dl?dst_uin=70001&spec=640'] = png();
    r.web['https://p.qlogo.cn/gh/99999/99999/640'] = png();
    r.fixture.inject([group(1, 54321, '@大肥鱼 戳一下小明，再看看他头像')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    const [found, poked, avatar, image, card, info] = r.seen.results;
    assert.ok(found.includes(`小明同学(${quiet})｜昵称 xm｜头衔 潜水王｜群等级 3`) && !found.includes('70001'), found);
    assert.ok(poked.includes('戳了戳'), poked);
    assert.ok(r.fixture.calls.some(item => item.action === 'group_poke' && String(item.params.user_id) === '70001'));
    assert.ok(avatar.includes('头像（助手看了）：助手看到：一只蓝色的鲸鱼'), avatar);
    assert.ok(image.includes('图发出去了'), image);
    const picture = r.fixture.payloads.at(-1).message;
    assert.equal(picture[0].data.text, '群头像\n');
    assert.ok(picture[1].type === 'image' && picture[1].data.file === 'base64://' + png().toString('base64'));
    assert.deepEqual(r.fixture.cards[0], {group_id: '99999', user_id: '12345', card: '鲸鱼'});
    assert.ok(card.includes('群名片改成了「鲸鱼」'), card);
    assert.ok(info.includes(`当前龙王：小红(${label('70002')})（连续 3 天）`) && info.includes(`群聊之火：xm(${quiet})`), info);
  } finally { await r.stop(); }
});

test('privateTurnsShowTheTypingState', async () => {
  const r = await rig([['send_message', {text: '在呢'}]], {shape: 'private'});
  try {
    r.fixture.inject([friend(601, '在吗')]);
    assert.ok(await r.finished(), JSON.stringify(r.seen.results));
    assert.deepEqual(r.fixture.typing[0], {user_id: '54321', event_type: 1});
    assert.deepEqual(r.fixture.segments().at(-1), ['text:在呢']);
  } finally { await r.stop(); }
});
