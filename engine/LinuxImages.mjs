// Port of LinuxImages (LinuxSupport.swift): every decode, resize and re-encode runs in the bounded Python/Pillow
// helper (upstream/Resources/Linux/image-helper.py); the engine never parses image bytes itself.
//
// Synchronous on purpose, like the Swift version (Process.waitUntilExit on the calling actor): callers such as
// QQStickerLibrary.data(for:) are synchronous and stay so.
//
// Windows: the helper imports the Unix-only `resource` module to cap memory, CPU time and output size. On Windows a
// stand-in module is installed first so the helper runs unchanged; there the 30 s kill bounds the time and the
// 20 MB output check below bounds the output, but there is no address-space cap.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {AppFailure, resources, temporaryDirectory, uuid} from './swift.mjs';
import {decodeBase64} from './foundation.mjs';

const bootstrap = [
  'import runpy, sys, types',
  'try:',
  '    import resource',
  'except ImportError:',
  '    resource = types.ModuleType("resource")',
  '    resource.RLIMIT_AS = resource.RLIMIT_CPU = resource.RLIMIT_FSIZE = 0',
  '    resource.setrlimit = lambda *args: None',
  '    sys.modules["resource"] = resource',
  'helper = sys.argv[1]',
  'sys.argv = [helper]',
  'runpy.run_path(helper, run_name="__main__")'
].join('\n');

export class LinuxImages {
  /** process(_:mode:options:) → [Data]; throws AppFailure. options is [String: Int]. */
  // Async in Node (Swift ran it synchronously on its own thread): a synchronous child process would stop the
  // whole engine — every chat, the QQ connection, the control page — for each image, up to the 30 s limit.
  static async process(data, mode, options = {}) {
    const directoryOfResources = resources();
    if (data.length > 32_000_000 || !directoryOfResources) throw new AppFailure('图片过大或资源目录不可用');
    const directory = path.join(temporaryDirectory(), 'dafeiyu-image-' + uuid());
    fs.mkdirSync(directory, {mode: 0o700});
    try {
      const input = path.join(directory, 'input'), output = path.join(directory, 'output');
      fs.writeFileSync(input, JSON.stringify({image: Buffer.from(data).toString('base64'), mode, options}));
      fs.writeFileSync(output, '', {mode: 0o600});
      const stdin = fs.openSync(input, 'r'), stdout = fs.openSync(output, 'w');
      let status;
      try {
        status = await new Promise(resolve => {
          const child = spawn(process.env.DAFEIYU_PYTHON || 'python',
            ['-P', '-c', bootstrap, path.join(directoryOfResources, 'Linux', 'image-helper.py')],
            {stdio: [stdin, stdout, 'ignore'], windowsHide: true});
          const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
          child.on('error', () => { clearTimeout(timer); resolve(-1); });
          child.on('exit', code => { clearTimeout(timer); resolve(code); });
        });
      } finally {
        fs.closeSync(stdin); fs.closeSync(stdout);
      }
      let encoded;
      try {
        const size = fs.statSync(output).size;
        if (status === 0 && size <= 20_000_000) encoded = JSON.parse(fs.readFileSync(output, 'utf8'));
      } catch { encoded = undefined; }
      if (!Array.isArray(encoded) || !encoded.every(item => typeof item === 'string')) {
        throw new AppFailure('图片格式、尺寸或处理时间不符合要求；请检查 Python Pillow 安装');
      }
      const images = encoded.map(decodeBase64).filter(Boolean);
      if (images.length !== encoded.length || images.length === 0) throw new AppFailure('图片处理失败');
      return images;
    } finally {
      try { fs.rmSync(directory, {recursive: true, force: true}); } catch {}
    }
  }
}
