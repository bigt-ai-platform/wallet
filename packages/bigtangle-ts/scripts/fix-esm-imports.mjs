import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve('dist');
const extensionPattern = /\.(?:js|json|node)$/;
const commonJsNamedImportPattern = /import\s+\{([^}]+)\}\s+from\s+['"](jackson-js|scrypt-js)['"];?/g;
const commonJsNamespaceImportPattern = /import\s+\*\s+as\s+(\w+)\s+from\s+['"](secp256k1)['"];?/g;

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpecifier(filePath, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return specifier;
  }

  if (extensionPattern.test(specifier)) {
    return specifier;
  }

  const absoluteSpecifier = path.resolve(path.dirname(filePath), specifier);
  if (await pathExists(`${absoluteSpecifier}.js`)) {
    return `${specifier}.js`;
  }

  if (await pathExists(path.join(absoluteSpecifier, 'index.js'))) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

async function fixFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  const replacements = new Map();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      replacements.set(match[1], await resolveSpecifier(filePath, match[1]));
    }
  }

  let output = source.replace(
    commonJsNamedImportPattern,
    (_match, imports, packageName) => {
      const destructuredImports = imports
        .split(',')
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .map((specifier) => specifier.replace(/\s+as\s+/u, ': '))
        .join(', ');
      const defaultImportName = packageName.replace(/[^a-z0-9]/giu, '_');

      return `import ${defaultImportName}Default from '${packageName}';\nconst { ${destructuredImports} } = ${defaultImportName}Default;`;
    },
  );
  output = output.replace(
    commonJsNamespaceImportPattern,
    (_match, importName, packageName) => `import ${importName} from '${packageName}';`,
  );
  for (const [from, to] of replacements) {
    if (from !== to) {
      output = output.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`);
    }
  }

  if (output !== source) {
    await writeFile(filePath, output);
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      await fixFile(entryPath);
    }
  }));
}

await walk(distDir);