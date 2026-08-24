const { buildSync } = require('esbuild');

const result = buildSync({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: 'local-source-test.ts',
    loader: 'ts',
    contents: String.raw`
      import { Schema } from '@milkdown/prose/model';
      import { EditorState, NodeSelection, TextSelection } from '@milkdown/prose/state';
      import { codeSpanMarkers, editableSourceRegion, imageSource, localSourceTokens } from './src/webview/localSourceReveal';

      const assert = (condition: unknown, message: string) => {
        if (!condition) throw new Error(message);
      };

      const schema = new Schema({
        nodes: {
          doc: { content: 'block+' },
          paragraph: { group: 'block', content: 'inline*' },
          text: { group: 'inline' },
          image: {
            inline: true,
            group: 'inline',
            atom: true,
            attrs: {
              src: { default: '' }, alt: { default: '' }, title: { default: '' }, width: { default: null },
            },
          },
        },
        marks: {
          link: { attrs: { href: {}, title: { default: null } } },
          strong: {},
          emphasis: {},
          strike_through: {},
          inlineCode: { inclusive: false },
        },
      });

      const strong = schema.marks.strong.create();
      const emphasis = schema.marks.emphasis.create();
      const nestedDoc = schema.node('doc', null, [schema.node('paragraph', null, [
        schema.text('plain '),
        schema.text('bold ', [strong]),
        schema.text('both', [strong, emphasis]),
        schema.text(' rest'),
      ])]);
      const nestedState = EditorState.create({
        doc: nestedDoc,
        selection: TextSelection.create(nestedDoc, 14),
      });
      const nested = localSourceTokens(nestedState);
      assert(nested.some((x) => x.pos === 7 && x.text === '**' && x.kind === 'open'), 'strong opening range');
      assert(nested.some((x) => x.pos === 12 && x.text === '*' && x.kind === 'open'), 'emphasis opening range');
      assert(nested.some((x) => x.pos === 16 && x.text === '*' && x.kind === 'close'), 'emphasis closing range');
      assert(nested.some((x) => x.pos === 16 && x.text === '**' && x.kind === 'close'), 'strong closing range');
      const nestedRegion = editableSourceRegion(nestedState);
      assert(nestedRegion?.from === 7 && nestedRegion.to === 16, 'editable nested range');
      assert(nestedRegion?.source === '**bold *both***', 'editable nested source');
      assert(nestedRegion?.caret === 10, 'editable source caret maps from document position');

      const strike = schema.marks.strike_through.create();
      const inlineCode = schema.marks.inlineCode.create();
      const codeDoc = schema.node('doc', null, [schema.node('paragraph', null, [
        schema.text('gone', [strike]), schema.text(' '), schema.text('a' + String.fromCharCode(96) + 'b', [inlineCode]),
      ])]);
      const strikeState = EditorState.create({ doc: codeDoc, selection: TextSelection.create(codeDoc, 3) });
      const strikeTokens = localSourceTokens(strikeState);
      assert(strikeTokens.filter((x) => x.text === '~~').length === 2, 'strike markers');
      const codeState = EditorState.create({ doc: codeDoc, selection: TextSelection.create(codeDoc, 8) });
      const codeTokens = localSourceTokens(codeState);
      assert(codeTokens.filter((x) => x.text === String.fromCharCode(96).repeat(2)).length === 2, 'inline code markers');

      const link = schema.marks.link.create({ href: 'docs/a b.md', title: 'Read "this"' });
      const linkDoc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('Docs', [link])])]);
      const linkState = EditorState.create({ doc: linkDoc, selection: TextSelection.create(linkDoc, 3) });
      const linkTokens = localSourceTokens(linkState);
      assert(linkTokens.some((x) => x.text === '['), 'link opening marker');
      assert(linkTokens.some((x) => x.text === '](<docs/a b.md> "Read \\"this\\"")'), 'link target marker');
      assert(editableSourceRegion(linkState)?.source === '[Docs](<docs/a b.md> "Read \\"this\\"")', 'editable link source');

      const tick = String.fromCharCode(96);
      const [codeOpen, codeClose] = codeSpanMarkers('a ' + tick.repeat(2) + ' b');
      assert(codeOpen === tick.repeat(3) && codeClose === tick.repeat(3), 'code fence longer than content run');
      const [paddedOpen, paddedClose] = codeSpanMarkers(tick + 'x');
      assert(paddedOpen === tick.repeat(2) + ' ' && paddedClose === ' ' + tick.repeat(2), 'code fence padding');

      const image = schema.nodes.image.create({
        src: 'images/a b.png', alt: 'a]b', title: 'Diagram', width: '320',
      });
      const imageDoc = schema.node('doc', null, [schema.node('paragraph', null, [image])]);
      const imageState = EditorState.create({
        doc: imageDoc,
        selection: NodeSelection.create(imageDoc, 1),
      });
      const imageTokens = localSourceTokens(imageState);
      assert(imageTokens.length === 1 && imageTokens[0].kind === 'image', 'selected image token');
      assert(imageTokens[0].text === '![a\\]b](<images/a b.png> "Diagram"){width=320}', 'image source');
      assert(imageSource(image) === imageTokens[0].text, 'image serializer consistency');
      assert(editableSourceRegion(imageState)?.source === imageTokens[0].text, 'editable image source');
    `,
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});

try {
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, { exports: {} }, {});
  console.log('[local-source] mark ranges, links, code spans, and images: OK');
} catch (error) {
  console.error('[local-source] FAIL:', error && error.stack ? error.stack : error);
  process.exit(1);
}
