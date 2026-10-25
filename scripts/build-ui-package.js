// Copy only the runtime dependency closure from the locked TDesign distribution.
// Run after installing/updating npm dependencies or using the IDE's "Build npm".
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../miniprogram');
const source = path.join(root, 'node_modules/tdesign-miniprogram/miniprogram_dist');
const target = path.join(root, 'miniprogram_npm/tdesign-miniprogram');
const runtimeExtensions = ['.js', '.json', '.wxml', '.wxss', '.wxs'];

function getPageRoutes(app) {
  return [...(app.pages || []), ...(app.subPackages || app.subpackages || []).flatMap((group) =>
    (group.pages || []).map((page) => path.posix.join(group.root, page)))];
}

function inside(base, file) {
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path outside package: ${file}`);
  return file;
}
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = inside(dir, path.join(dir, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in generated package: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function resolveFile(base) {
  const candidates = [base, ...runtimeExtensions.map((ext) => base + ext), path.join(base, 'index.js')];
  const found = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found) throw new Error(`Unresolved runtime dependency: ${base}`);
  return inside(source, found);
}
function resolveImport(from, specifier) {
  if (specifier.startsWith('.')) return resolveFile(path.resolve(path.dirname(from), specifier));
  if (specifier.startsWith('/')) throw new Error(`Unexpected absolute vendor import: ${specifier}`);
  let dir = path.dirname(from);
  while (dir === source || dir.startsWith(source + path.sep)) {
    const base = path.join(dir, 'miniprogram_npm', specifier);
    if (fs.existsSync(base) || fs.existsSync(base + '.js')) return resolveFile(base);
    dir = path.dirname(dir);
  }
  throw new Error(`Unresolved npm dependency ${specifier} from ${from}`);
}

function collect() {
  if (!fs.existsSync(source)) throw new Error('Run npm ci in miniprogram before building the UI package.');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const configurations = [app, ...getPageRoutes(app).map((page) => JSON.parse(fs.readFileSync(inside(root, path.join(root, page + '.json')), 'utf8')))];
  const retained = new Set();
  const components = new Set();
  function addComponent(base) {
    inside(source, base);
    components.add(path.relative(source, base).replaceAll('\\', '/'));
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      const file = base + ext;
      if (fs.existsSync(file)) visit(file);
      else if (ext !== '.wxss') throw new Error(`Missing component file: ${file}`);
    }
  }
  function visit(file) {
    inside(source, file);
    if (retained.has(file)) return;
    retained.add(file);
    const content = fs.readFileSync(file, 'utf8');
    const ext = path.extname(file);
    if (ext === '.json') {
      const config = JSON.parse(content);
      for (const spec of Object.values(config.usingComponents || {})) {
        if (!spec.startsWith('.')) throw new Error(`Unexpected vendor component path: ${spec}`);
        addComponent(path.resolve(path.dirname(file), spec));
      }
    }
    if (ext === '.js' || ext === '.wxs') {
      // TDesign 1.15.2 ships static ESM imports/re-exports and literal WXS requires.
      const imports = /\b(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
      for (const match of content.matchAll(imports)) visit(resolveImport(file, match[1]));
      if (/\b(?:require|import)\s*\(\s*[^'"\s]/.test(content)) throw new Error(`Dynamic import needs explicit handling: ${file}`);
    }
    if (ext === '.wxss') {
      for (const match of content.matchAll(/@import\s*['"]([^'"]+)['"]/g)) visit(resolveImport(file, match[1]));
      for (const match of content.matchAll(/url\(\s*['"]?([^\s'"\)]+)['"]?\s*\)/g)) {
        if (!/^(https?:|data:|\/\/)/.test(match[1])) visit(resolveImport(file, match[1]));
      }
    }
    if (ext === '.wxml') {
      for (const match of content.matchAll(/<(?:import|include|wxs)\b[^>]*\bsrc=['"]([^'"]+)['"]/g)) visit(resolveImport(file, match[1]));
    }
  }
  for (const config of configurations) {
    for (const spec of Object.values(config.usingComponents || {})) {
      if (spec.startsWith('tdesign-miniprogram/')) addComponent(path.join(source, spec.slice('tdesign-miniprogram/'.length)));
    }
  }
  // Keep any distributed license notices even when they are not runtime imports.
  for (const file of walk(source)) if (/^(license|licence|notice)(\.|$)/i.test(path.basename(file))) retained.add(file);
  const license = path.join(path.dirname(source), 'LICENSE');
  if (!fs.existsSync(license)) throw new Error('TDesign LICENSE is missing from the installed package.');
  return { retained, components, license };
}

function build({ check = false } = {}) {
  const { retained, components, license } = collect();
  const sources = new Map([...retained].map((file) => [path.relative(source, file), file]));
  sources.set('LICENSE', license);
  const relativeFiles = [...sources.keys()].sort();
  const expected = new Set(relativeFiles);
  inside(root, target);
  if (check && !fs.existsSync(target)) throw new Error('UI package is missing; run npm run build:ui.');
  if (!check) fs.mkdirSync(target, { recursive: true });
  // Resolve the final absolute destination before removing even one stale file.
  inside(fs.realpathSync(root), fs.realpathSync(target));
  const expectedTarget = path.join(fs.realpathSync(root), 'miniprogram_npm/tdesign-miniprogram');
  if (fs.realpathSync(target).toLowerCase() !== expectedTarget.toLowerCase()) throw new Error('Generated package path resolves through a symlink/junction.');
  const existing = walk(target);
  const stale = existing.filter((file) => !expected.has(path.relative(target, file)));
  const changed = relativeFiles.filter((file) => !fs.existsSync(path.join(target, file))
    || !fs.readFileSync(sources.get(file)).equals(fs.readFileSync(path.join(target, file))));
  if (check && (stale.length || changed.length)) throw new Error('Generated UI package is stale; run npm run build:ui in miniprogram.');
  if (!check) {
    for (const file of relativeFiles) {
      const destination = inside(target, path.join(target, file));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sources.get(file), destination);
    }
    // Files only: no recursive directory deletion and no modification to node_modules.
    for (const file of stale) fs.unlinkSync(inside(target, file));
  }
  const bytes = relativeFiles.reduce((sum, file) => sum + fs.statSync(sources.get(file)).size, 0);
  return { files: relativeFiles.length, components: [...components].sort(), bytes, removedFiles: stale.length };
}

if (require.main === module) console.log(JSON.stringify(build({ check: process.argv.includes('--check') }), null, 2));
module.exports = { collect, build, getPageRoutes };
