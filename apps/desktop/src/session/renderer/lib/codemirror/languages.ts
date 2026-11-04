import { StreamLanguage, type StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

const stream = (parser: StreamParser<unknown>): Extension => StreamLanguage.define(parser);

/** Registry language IDs are the only language authority; no filename recognition here. */
const loaders: Record<string, () => Promise<Extension>> = {
  javascript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  jsonc: () => import('@codemirror/lang-json').then(m => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  vue: () => import('@codemirror/lang-vue').then(m => m.vue()),
  php: () => import('@codemirror/lang-php').then(m => m.php()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
  c: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.c)),
  cpp: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.cpp)),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.csharp)),
  java: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.java)),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.kotlin)),
  scala: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.scala)),
  dart: () => import('@codemirror/legacy-modes/mode/clike').then(m => stream(m.dart)),
  python: () => import('@codemirror/legacy-modes/mode/python').then(m => stream(m.python)),
  go: () => import('@codemirror/legacy-modes/mode/go').then(m => stream(m.go)),
  rust: () => import('@codemirror/legacy-modes/mode/rust').then(m => stream(m.rust)),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then(m => stream(m.ruby)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then(m => stream(m.swift)),
  bash: () => import('@codemirror/legacy-modes/mode/shell').then(m => stream(m.shell)),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then(m => stream(m.shell)),
  yaml: () => import('@codemirror/legacy-modes/mode/yaml').then(m => stream(m.yaml)),
  xml: () => import('@codemirror/legacy-modes/mode/xml').then(m => stream(m.xml)),
  scss: () => import('@codemirror/legacy-modes/mode/css').then(m => stream(m.sCSS)),
  less: () => import('@codemirror/legacy-modes/mode/css').then(m => stream(m.less)),
  sass: () => import('@codemirror/legacy-modes/mode/sass').then(m => stream(m.sass)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then(m => stream(m.lua)),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then(m => stream(m.perl)),
  r: () => import('@codemirror/legacy-modes/mode/r').then(m => stream(m.r)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then(m => stream(m.dockerFile)),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then(m => stream(m.toml)),
  ini: () => import('@codemirror/legacy-modes/mode/properties').then(m => stream(m.properties)),
  properties: () => import('@codemirror/legacy-modes/mode/properties').then(m => stream(m.properties)),
};

// Svelte, Makefile and MATLAB remain disclosed syntax gaps in phase one (TP14249677).
export function loadLanguage(languageId: string): Promise<Extension> {
  return loaders[languageId]?.() ?? Promise.resolve([]);
}
