const { buildSync } = require('esbuild');
const path = require('path');

const output = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/webview/listSyntax.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require);
const { bulletMarkerAt, consumeListStyleMarker, orderedLabel, preprocessExtendedLists } = loaded.exports;

function equal(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${name}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${name}`);
  }
}

equal(
  'lower alpha list is converted with metadata',
  preprocessExtendedLists('a. Alpha\nb. Beta'),
  '1. MDWLISTSTYLE:lower-alpha Alpha\n2. Beta'
);
equal(
  'upper Roman list keeps its numeric start',
  preprocessExtendedLists('IV. Four\nV. Five'),
  '4) MDWLISTSTYLE:upper-roman Four\n5) Five'
);
equal(
  'single ambiguous sentence stays plain text',
  preprocessExtendedLists('I. think this is prose'),
  'I. think this is prose'
);
equal(
  'single-letter i/j sequence is alphabetic',
  preprocessExtendedLists('i. Nine\nj. Ten'),
  '9. MDWLISTSTYLE:lower-alpha Nine\n10. Ten'
);
equal(
  'adjacent alpha and Roman groups stay distinct',
  preprocessExtendedLists('a. Alpha\nb. Beta\n\nIV. Four\nV. Five'),
  '1. MDWLISTSTYLE:lower-alpha Alpha\n2. Beta\n\n4) MDWLISTSTYLE:upper-roman Four\n5) Five'
);
equal(
  'fenced code is not rewritten',
  preprocessExtendedLists('```md\na. code\nb. code\n```'),
  '```md\na. code\nb. code\n```'
);
equal('alphabetic label conversion', orderedLabel(28, 'upper-alpha'), 'AB');
equal('Roman label conversion', orderedLabel(14, 'lower-roman'), 'xiv');
equal(
  'alphabetic sequence continues after z',
  preprocessExtendedLists('z. Twenty six\naa. Twenty seven\nab. Twenty eight'),
  '26. MDWLISTSTYLE:lower-alpha Twenty six\n27. Twenty seven\n28. Twenty eight'
);
equal(
  'internal marker is removed without losing item text',
  JSON.stringify(consumeListStyleMarker('MDWLISTSTYLE:lower-alpha Alpha first item')),
  JSON.stringify({ style: 'lower-alpha', text: 'Alpha first item' })
);
equal('plus bullet marker is retained', bulletMarkerAt('text\n+ Item', 5), '+');
equal('star bullet marker is retained', bulletMarkerAt('  * Item', 0), '*');

if (!process.exitCode) console.log('[list-syntax] ALL CHECKS PASSED');
