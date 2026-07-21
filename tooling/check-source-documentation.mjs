import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import ts from "typescript";

const rootPath = resolve(import.meta.dirname, "..");
const excludedDirectoryNames = new Set(["coverage", "dist", "node_modules"]);
const sourceFiles = [
  ...(await discoverSourceFiles(resolve(rootPath, "apps"))),
  ...(await discoverSourceFiles(resolve(rootPath, "tooling"))),
  "eslint.config.js",
].sort();
const routeMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "route",
]);

const findings = [];
let checkedCallables = 0;
let checkedEndpoints = 0;
for (const sourcePath of sourceFiles) {
  if (sourcePath.endsWith(".d.ts") || sourcePath.includes(".generated.")) {
    continue;
  }

  const absolutePath = resolve(rootPath, sourcePath);
  const source = await readFile(absolutePath, "utf8");
  if (sourcePath.endsWith(".vue")) {
    for (const script of vueScripts(source)) {
      inspectSource(sourcePath, script.source, script.lineOffset);
    }
  } else if (/\.(?:[cm]?js|ts)$/u.test(sourcePath)) {
    inspectSource(sourcePath, source, 0);
  }
}

if (findings.length !== 0) {
  console.error("Source documentation is required for:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Source documentation check passed for ${checkedCallables} named callables and ${checkedEndpoints} endpoints across ${sourceFiles.length} files.`,
  );
}

/** Recursively discovers hand-written JavaScript, TypeScript, and Vue files. */
async function discoverSourceFiles(directoryPath) {
  const discovered = [];
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const absolutePath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        discovered.push(...(await discoverSourceFiles(absolutePath)));
      }
    } else if (
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs") ||
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".vue")
    ) {
      discovered.push(relative(rootPath, absolutePath).split(sep).join("/"));
    }
  }
  return discovered.sort();
}

/**
 * Inspects one TypeScript source unit for documented named callables and routes.
 */
function inspectSource(sourcePath, source, lineOffset) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  visit(sourceFile);

  /** Walks declarations and route-call statements in source order. */
  function visit(node) {
    if (isDocumentedCallable(node)) {
      checkedCallables += 1;
      if (!hasLeadingDocumentation(node, sourceFile)) {
        findings.push(
          `${relative(rootPath, resolve(rootPath, sourcePath))}:${lineOf(
            sourceFile,
            node,
            lineOffset,
          )} ${callableName(node)}`,
        );
      }
    }

    if (isRouteDeclaration(node)) {
      checkedEndpoints += 1;
      if (!hasLeadingDocumentation(node, sourceFile)) {
        findings.push(
          `${relative(rootPath, resolve(rootPath, sourcePath))}:${lineOf(
            sourceFile,
            node,
            lineOffset,
          )} ${routeName(node)} endpoint`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }
}

/** Returns script blocks from a Vue SFC with offsets for useful diagnostics. */
function vueScripts(source) {
  const scripts = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gu;
  for (const match of source.matchAll(pattern)) {
    const content = match[1] ?? "";
    const contentStart = (match.index ?? 0) + match[0].indexOf(content);
    scripts.push({
      source: content,
      lineOffset: source.slice(0, contentStart).split("\n").length - 1,
    });
  }
  return scripts;
}

/** Identifies implemented named callables that require local documentation. */
function isDocumentedCallable(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.body !== undefined && node.name !== undefined;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return true;
  }
  return ts.isFunctionExpression(node) && node.name !== undefined;
}

/** Detects Fastify endpoint declarations made through the local server object. */
function isRouteDeclaration(node) {
  if (
    !ts.isExpressionStatement(node) ||
    !ts.isCallExpression(node.expression)
  ) {
    return false;
  }
  const target = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "server" &&
    routeMethods.has(target.name.text)
  );
}

/** Checks for an immediately associated JSDoc-style block comment. */
function hasLeadingDocumentation(node, sourceFile) {
  const documentedNode =
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : node;
  const leadingText = sourceFile.text.slice(
    documentedNode.getFullStart(),
    documentedNode.getStart(),
  );
  return /\/\*\*[\s\S]*?\*\/\s*$/u.test(leadingText);
}

/** Produces a stable human-readable name for an undocumented callable. */
function callableName(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if ("name" in node && node.name !== undefined) {
    return node.name.getText();
  }
  return "<callable>";
}

/** Produces the HTTP method and path for an undocumented route declaration. */
function routeName(node) {
  const call = node.expression;
  const target = call.expression;
  const method = ts.isPropertyAccessExpression(target)
    ? target.name.text.toUpperCase()
    : "HTTP";
  const path = call.arguments[0];
  return `${method} ${path === undefined ? "<path>" : path.getText()}`;
}

/** Maps an AST node to its original TypeScript or Vue source line. */
function lineOf(sourceFile, node, lineOffset) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
    1 +
    lineOffset
  );
}
