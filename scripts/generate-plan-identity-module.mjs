#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(scriptDir, '..', 'src', 'shared', 'plan-identity.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    removeComments: false,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${ts.flattenDiagnosticMessageText(error.messageText, '\n')}\n`);
  process.exit(1);
}
process.stdout.write('// GENERATED from src/shared/plan-identity.ts — DO NOT EDIT.\n' + result.outputText);
