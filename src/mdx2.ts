import generate from '@babel/generator';
import * as t from '@babel/types';
import cloneDeep from 'lodash/cloneDeep';
import toBabel from 'estree-to-babel';

// Keeping as much code as possible from the original compiler to avoid breaking changes
import {
  genCanvasExports,
  genStoryExport,
  genMeta,
  CompilerOptions,
  Context,
  MetaExport,
  wrapperJs,
  stringifyMeta,
} from './sb-mdx-plugin';

export const SEPARATOR = '// =========';

export { wrapperJs };

function extractExports(root: t.File, options: CompilerOptions) {
  const context: Context = {
    counter: 0,
    storyNameToKey: {},
    namedExports: {},
    importedStoryNames: new Map([]),
  };
  const storyExports = [];
  const includeStories = [];
  let metaExport: MetaExport | null = null;
  const { code } = generate(root, {});
  let contents: t.ExpressionStatement;
  root.program.body.forEach((child) => {
    if (t.isExpressionStatement(child) && t.isJSXFragment(child.expression)) {
      if (contents) throw new Error('duplicate contents');
      contents = child;
    } else if (
      t.isExportNamedDeclaration(child) &&
      t.isVariableDeclaration(child.declaration) &&
      child.declaration.declarations.length === 1
    ) {
      const declaration = child.declaration.declarations[0];
      if (t.isVariableDeclarator(declaration) && t.isIdentifier(declaration.id)) {
        const { name } = declaration.id;
        context.namedExports[name] = declaration.init;
      }
    }
  });
  if (contents) {
    const jsx = contents.expression as t.JSXFragment;
    jsx.children.forEach((child) => {
      if (t.isJSXElement(child)) {
        if (t.isJSXIdentifier(child.openingElement.name)) {
          const name = child.openingElement.name.name;
          let stories;
          if (['Canvas', 'Preview'].includes(name)) {
            stories = genCanvasExports(child, context);
          } else if (name === 'Story') {
            stories = genStoryExport(child, context);
          } else if (name === 'Meta') {
            const meta = genMeta(child, options);
            if (meta) {
              if (metaExport) {
                throw new Error('Meta can only be declared once');
              }
              metaExport = meta;
            }
          }
          if (stories) {
            Object.entries(stories).forEach(([key, story]) => {
              includeStories.push(key);
              storyExports.push(story);
            });
          }
        }
      } else if (t.isJSXExpressionContainer(child)) {
        // Skip string literals & other JSX expressions
      } else {
        throw new Error(`Unexpected JSX child: ${child.type}`);
      }
    });
  }

  if (metaExport) {
    if (!storyExports.length) {
      storyExports.push('export const __page = () => { throw new Error("Docs-only story"); };');
      storyExports.push('__page.parameters = { docsOnly: true };');
      includeStories.push('__page');
    }
  } else {
    metaExport = {};
  }
  metaExport.includeStories = JSON.stringify(includeStories);

  const fullJsx = [
    ...storyExports,
    `const componentMeta = ${stringifyMeta(metaExport)};`,
    `const mdxStoryNameToKey = ${JSON.stringify(context.storyNameToKey)};`,
    wrapperJs,
    'export default componentMeta;',
  ].join('\n\n');

  return { fullJsx, context };
}

export const applyImportedStoryNames = (
  visit: any,
  root: any,
  importedStoryNames: Context['importedStoryNames']
) => {
  visit(root, 'mdxJsxFlowElement', (node: any) => {
    const { name, position } = node;
    const value = importedStoryNames.get(`${position.start.offset}-${position.end.offset}`);
    if (name === 'Story' && value) {
      node.attributes.push({
        type: 'mdxJsxAttribute',
        name: 'name',
        value,
      });
    }
  });
  return root;
};

export const plugin = (store: any) => (root: any) => {
  const estree = store.toEstree(root);
  // toBabel mutates root, so we need to clone it
  const clone = cloneDeep(estree);
  const babel = toBabel(clone);
  const { context, fullJsx } = extractExports(babel, {});
  store.exports = fullJsx;
  return store.transformRoot(root, context);
};

export const postprocess = (code: string, extractedExports: string) => {
  const lines = code.toString().trim().split('\n');

  // /*@jsxRuntime automatic @jsxImportSource react*/
  const first = lines.shift();

  return [
    first,
    'import { assertIsFn, AddContext } from "@storybook/addon-docs";',
    ...lines.filter((line) => !line.match(/^export default/)),
    SEPARATOR,
    extractedExports,
  ].join('\n');
};

export const mdxSync = (code: string) => {
  const { compileSync } = require('@mdx-js/mdx');
  const { toEstree } = require('hast-util-to-estree');
  const { visit } = require('unist-util-visit');
  const transformRoot = (root: any, context: Context) => {
    applyImportedStoryNames(visit, root, context.importedStoryNames);
  };

  const store = { exports: '', toEstree, transformRoot };
  const output = compileSync(code, {
    rehypePlugins: [[plugin, store]],
  });
  return postprocess(output.toString(), store.exports);
};

export { mdxSync as compileSync };
