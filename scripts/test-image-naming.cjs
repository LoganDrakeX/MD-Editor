/**
 * imageNaming 纯函数单元测试（用 esbuild 就地编译 TS → CJS 运行）。
 * 用法: node scripts/test-image-naming.cjs
 */
const { buildSync } = require('esbuild');

const result = buildSync({
  entryPoints: ['src/imageNaming.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});

const mod = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
const {
  mimeToExtension,
  sanitizeFileName,
  splitExt,
  candidateNames,
  withSuffix,
} = mod.exports;

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('  FAIL ' + label);
  }
}

console.log('[naming] mimeToExtension');
assert(mimeToExtension('image/png') === 'png', 'png');
assert(mimeToExtension('image/jpeg') === 'jpg', 'jpeg→jpg');
assert(mimeToExtension('image/svg+xml') === 'svg', 'svg+xml');
assert(mimeToExtension('application/octet-stream') === 'png', 'unknown → fallback png');

console.log('[naming] sanitizeFileName');
assert(sanitizeFileName('a<b>:c?.png') === 'a_b__c_.png', '非法字符替换');
assert(sanitizeFileName('..hidden') === 'hidden', '去除首部点');
assert(sanitizeFileName('') === 'image', '空名回退');

console.log('[naming] splitExt');
const se = splitExt('photo.JPG');
assert(se.base === 'photo' && se.ext === 'jpg', 'photo.JPG → photo/jpg');
assert(splitExt('noext').base === 'noext' && splitExt('noext').ext === '', '无扩展名');

console.log('[naming] candidateNames');
assert(candidateNames('timestamp', 'x.png', 'image/png', 123)[0] === '123.png', 'timestamp');
assert(
  candidateNames('original', 'photo.png', 'image/png', 123)[0] === 'photo.png',
  'original 保留原名'
);
assert(
  candidateNames('original', '无扩展', 'image/png', 123)[0] === '无扩展.png',
  'original 无扩展补 png'
);
assert(
  candidateNames('timestamp-original', 'photo.JPG', 'image/jpeg', 123)[0] === '123-photo.jpg',
  'timestamp-original（用 mime 扩展名）'
);

console.log('[naming] withSuffix');
assert(withSuffix('photo.png', 1) === 'photo-1.png', '保留扩展名');
assert(withSuffix('noext', 1) === 'noext-1', '无扩展名');

if (failed) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\n[naming] ALL PASSED');
