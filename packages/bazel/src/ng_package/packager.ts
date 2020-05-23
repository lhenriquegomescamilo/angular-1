/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as fs from 'fs';
import * as path from 'path';
import * as shx from 'shelljs';

function main(args: string[]): number {
  // Exit immediately when encountering an error.
  shx.set('-e');

  // Keep track of whether an error has occured so that we can return an appropriate exit code.
  let errorHasOccured = false;

  // This utility expects all of its arguments to be specified in a params file generated by
  // bazel (see https://docs.bazel.build/versions/master/skylark/lib/Args.html#use_param_file).
  const paramFilePath = args[0];

  // Bazel params may be surrounded with quotes
  function unquoteParameter(s: string) {
    return s.replace(/^'(.*)'$/, '$1');
  }

  // Parameters are specified in the file one per line.
  const params = fs.readFileSync(paramFilePath, 'utf-8').split('\n').map(unquoteParameter);

  const [
      // Output directory for the npm package.
      out,

      // The package segment of the ng_package rule's label (e.g. 'package/common').
      srcDir,

      // The bazel-bin dir joined with the srcDir (e.g. 'bazel-bin/package.common').
      // This is the intended output location for package artifacts.
      binDir,

      // The bazel-genfiles dir joined with the srcDir (e.g. 'bazel-bin/package.common').
      genfilesDir,

      // JSON data mapping each entry point to the generated bundle index and
      // flat module metadata, for example
      // {"@angular/core": {
      //     "index": "bazel-bin/packages/core/core.js",
      //     "typings": "bazel-bin/packages/core/core.d.ts",
      //     "metadata": "bazel-bin/packages/core/core.metadata.json"
      //  },
      // ...
      // }
      modulesManifestArg,

      // Path to the package's README.md.
      readmeMd,

      // List of rolled-up flat ES2015 modules
      fesm2015Arg,

      // List of rolled-up flat ES5 modules
      fesm5Arg,

      // List of individual ES2015 modules
      esm2015Arg,

      // List of individual ES5 modules
      esm5Arg,

      // List of all UMD bundles generated by rollup.
      bundlesArg,

      // List of all files in the ng_package rule's srcs.
      srcsArg,

      // List of all type definitions that need to packaged into the ng_package.
      typeDefinitionsArg,

      // List of all files in the ng_package rule's data.
      dataArg,

      // Path to the package's LICENSE.
      licenseFile,

      // List of all dts bundles generated by the API extractor.
      dtsBundleArg,

      // The dts bundle file suffix example: '.bundle.d.ts'
      dtsBundleFileSuffix,
  ] = params;

  const fesm2015 = fesm2015Arg.split(',').filter(s => !!s);
  const fesm5 = fesm5Arg.split(',').filter(s => !!s);
  const esm2015 = esm2015Arg.split(',').filter(s => !!s);
  const esm5 = esm5Arg.split(',').filter(s => !!s);
  const bundles = bundlesArg.split(',').filter(s => !!s);
  const typeDefinitions = typeDefinitionsArg.split(',').filter(s => !!s);
  const srcs = srcsArg.split(',').filter(s => !!s);
  const dataFiles: string[] = dataArg.split(',').filter(s => !!s);
  const modulesManifest = JSON.parse(modulesManifestArg);
  const dtsBundles: string[] = dtsBundleArg.split(',').filter(s => !!s);

  /**
   * List of known `package.json` fields which provide information about
   * supported package formats and their associated entry paths.
   */
  const knownFormatPackageJsonFields =
      ['main', 'fesm2015', 'esm2015', 'typings', 'module', 'es2015'];

  if (readmeMd) {
    copyFile(readmeMd, out);
  }

  /**
   * Writes a file into the package based on its input path, relativizing to the package path.
   * @param inputPath Path to the file in the input tree.
   * @param fileContent Content of the file.
   */
  function writeFileFromInputPath(inputPath: string, fileContent: string|Buffer) {
    // We want the relative path from the given file to its ancestor "root" directory.
    // This root depends on whether the file lives in the source tree (srcDir) as a basic file
    // input to ng_package, the bin output tree (binDir) as the output of another rule, or
    // the genfiles output tree (genfilesDir) as the output of a genrule.
    let rootDir: string;
    if (inputPath.includes(binDir)) {
      rootDir = binDir;
    } else if (inputPath.includes(genfilesDir)) {
      rootDir = genfilesDir;
    } else {
      rootDir = srcDir;
    }

    const outputPath = path.join(out, path.relative(rootDir, inputPath));

    // Always ensure that the target directory exists.
    shx.mkdir('-p', path.dirname(outputPath));
    fs.writeFileSync(outputPath, fileContent);
  }

  /**
   * Copies a file into the package based on its input path, relativizing to the package path.
   * @param inputPath a path relative to the binDir, typically from a file in the deps[]
   */
  function copyFileFromInputPath(inputPath: string) {
    writeFileFromInputPath(inputPath, fs.readFileSync(inputPath));
  }

  /**
   * Relativize the path where a file is written.
   * @param file a path containing a re-rooted segment like .esm5
   * @param suffix the re-rooted directory
   * @param outDir path where we copy the file, relative to the out
   */
  function writeEsmFile(file: string, suffix: string, outDir: string) {
    function relPath(file: string, suffix: string) {
      if (suffix) {
        // Note that the specified file path is always using the posix path delimiter.
        const root =
            suffix ? file.substr(0, file.lastIndexOf(`${suffix}/`) + suffix.length + 1) : binDir;
        return path.dirname(path.relative(path.join(root, srcDir), file));
      } else {
        return path.dirname(path.relative(binDir, file));
      }
    }
    const rel = relPath(file, suffix);
    if (!rel.startsWith('..')) {
      copyFile(file, path.join(out, outDir), rel);
    }
  }

  esm2015.forEach(file => writeEsmFile(file, '', 'esm2015'));

  bundles.forEach(bundle => {
    copyFile(bundle, out, 'bundles');
  });
  fesm2015.forEach(file => {
    copyFile(file, out, 'fesm2015');
  });

  // Copy all type definitions into the package. This is necessary so that developers can use
  // the package with type definitions.
  typeDefinitions.forEach(f => writeFileFromInputPath(f, readTypingsAndStripAmdModule(f)));

  // Copy all `data` files into the package. These are files that aren't built by the ng_package
  // rule, but instead are just straight copied into the package, e.g. global CSS assets.
  dataFiles.forEach(f => copyFileFromInputPath(f));

  // Iterate through the entry point modules
  // We do this first because we also record new paths for the esm5 and esm2015 copies
  // of the index JS file, which we need to amend the package.json.
  Object.keys(modulesManifest).forEach(moduleName => {
    const moduleFiles = modulesManifest[moduleName];
    const relative = path.relative(binDir, moduleFiles['index']);

    moduleFiles['esm5_index'] = path.join(binDir, 'esm5', relative);
    moduleFiles['esm2015_index'] = path.join(binDir, 'esm2015', relative);

    // Metadata file is optional as entry-points can be also built
    // with the "ts_library" rule.
    const metadataFile = moduleFiles['metadata'];
    if (!metadataFile) {
      return;
    }

    const typingsOutFile = moduleFiles['typings'];
    // We only support all modules within a package to be dts bundled
    // ie: if @angular/common/http has flat dts, so should @angular/common
    if (dtsBundles.length) {
      const metadataContent = rewireMetadata(metadataFile, typingsOutFile);
      writeFileFromInputPath(metadataFile, metadataContent);
    } else {
      copyFileFromInputPath(metadataFile);
    }
  });

  const licenseBanner = licenseFile ? fs.readFileSync(licenseFile, 'utf-8') : '';

  dtsBundles.forEach(bundleFile => {
    const cleanDistPath = bundleFile.replace(dtsBundleFileSuffix, '.d.ts');
    // API extractor will not dedupe license comments from various files
    // this will remove all the license comments and append the license banner.
    const content = licenseBanner + '\n' +
        readTypingsAndStripAmdModule(bundleFile)
            .replace(/(\/\*\*\s+\*\s\@license(((?!\*\/).|\s)*)\*\/)/gm, '');

    writeFileFromInputPath(cleanDistPath, content);
  });

  // Root package name (e.g. '@angular/common'), captures as we iterate through sources below.
  let rootPackageName = '';
  const packagesWithExistingPackageJson = new Set<string>();

  for (const src of srcs) {
    if (src.includes(binDir) || src.includes(genfilesDir)) {
      errorHasOccured = true;
      console.error(
          'The "srcs" for ng_package should not include output of other rules. Found:\n' +
          `  ${src}`);
    }

    let content = fs.readFileSync(src, 'utf-8');
    // Modify package.json files as necessary for publishing
    if (path.basename(src) === 'package.json') {
      const packageJson = JSON.parse(content);
      content = amendPackageJson(src, packageJson, false);

      const packageName = packageJson['name'];
      packagesWithExistingPackageJson.add(packageName);

      // Keep track of the root package name, e.g. "@angular/common". We assume that the
      // root name will be shortest because secondary entry-points will append to it
      // (e.g. "@angular/common/http").
      if (!rootPackageName || packageName.length < rootPackageName.length) {
        rootPackageName = packageJson['name'];
      }
    }
    writeFileFromInputPath(src, content);
  }

  // Generate extra files for secondary entry-points.
  Object.keys(modulesManifest).forEach(entryPointPackageName => {
    const entryPointName = entryPointPackageName.substr(rootPackageName.length + 1);
    if (!entryPointName) return;

    const metadataFilePath = modulesManifest[entryPointPackageName]['metadata'];
    if (metadataFilePath) {
      createMetadataReexportFile(
          entryPointName, modulesManifest[entryPointPackageName]['metadata'],
          entryPointPackageName);
    }

    createTypingsReexportFile(
        entryPointName, licenseBanner, modulesManifest[entryPointPackageName]['typings']);

    if (!packagesWithExistingPackageJson.has(entryPointPackageName)) {
      createEntryPointPackageJson(entryPointName, entryPointPackageName);
    }
  });

  return errorHasOccured ? 1 : 0;

  /**
   * Convert a binDir-relative path to srcDir-relative
   * @param from path to a file under the srcDir, like packages/core/testing/package.json
   * @param file path to a file under the binDir, like bazel-bin/core/testing/generated.js
   */
  function srcDirRelative(from: string, file: string) {
    const result = normalizeSeparators(
        path.relative(path.dirname(from), path.join(srcDir, path.relative(binDir, file))));
    if (result.startsWith('..')) return result;
    return `./${result}`;
  }

  function copyFile(file: string, baseDir: string, relative = '.') {
    const dir = path.join(baseDir, relative);
    // output file is .js if the input file is .mjs
    const outFile = path.posix.join(
        dir, path.basename(file.endsWith('.mjs') ? file.replace(/\.mjs$/, '.js') : file));
    shx.mkdir('-p', dir);
    shx.cp(file, outFile);
    // Double-underscore is used to escape forward slash in FESM filenames.
    // See ng_package.bzl:
    //   fesm_output_filename = entry_point.replace("/", "__")
    // We need to unescape these.
    if (outFile.indexOf('__') >= 0) {
      const outputPath = path.join(dir, ...path.basename(outFile).split('__'));
      shx.mkdir('-p', path.dirname(outputPath));
      shx.mv(path.join(dir, path.basename(file)), outputPath);

      // if we are renaming the .js file, we'll also need to update the sourceMappingURL in the file
      if (outFile.endsWith('.js')) {
        shx.chmod('+w', outputPath);
        shx.sed('-i', `${path.basename(file)}.map`, `${path.basename(outputPath)}.map`, outputPath);
      }
    }
  }

  /**
   * Inserts or edits properties into the package.json file(s) in the package so that
   * they point to all the right generated artifacts.
   *
   * @param packageJson The path to the package.json file.
   * @param parsedPackage Parsed package.json content
   * @param isGeneratedPackageJson Whether the passed package.json has been generated.
   */
  function amendPackageJson(
      packageJson: string, parsedPackage: {[key: string]: string},
      isGeneratedPackageJson: boolean) {
    const packageName = parsedPackage['name'];
    const moduleData = modulesManifest[packageName];

    // If a package json file has been discovered that does not match any
    // module in the manifest, we report a warning as most likely the target
    // is configured incorrectly (e.g. missing `module_name` attribute).
    if (!moduleData) {
      // Ideally we should throw here, as we got an entry point that doesn't
      // have flat module metadata / bundle index, so it may have been an
      // ng_module that's missing a module_name attribute.
      // However, @angular/compiler can't be an ng_module, as it's the internals
      // of the ngc compiler, yet we want to build an ng_package for it.
      // So ignore package.json files when we are missing data.
      console.error('WARNING: no module metadata for package', packageName);
      console.error('   Not updating the package.json file to point to it');
      console.error(
          '   The ng_module for this package is possibly missing the module_name attribute ');
      return JSON.stringify(parsedPackage, null, 2);
    }

    // If we guessed the index paths for a module, and it contains an explicit `package.json`
    // file that already sets format properties, we skip automatic insertion of format
    // properties but report a warning in case properties have been set by accident.
    if (moduleData.guessedPaths && !isGeneratedPackageJson &&
        hasExplicitFormatProperties(parsedPackage)) {
      console.error('WARNING: `package.json` explicitly sets format properties (like `main`).');
      console.error(
          '    Skipping automatic insertion of format properties as explicit ' +
          'format properties are set.');
      console.error('    Ignore this warning if explicit properties are set intentionally.');
      return JSON.stringify(parsedPackage, null, 2);
    }

    // Derive the paths to the files from the hard-coded names we gave them.
    // TODO(alexeagle): it would be better to transfer this information from the place
    // where we created the filenames, via the modulesManifestArg
    parsedPackage['main'] = getBundleName(packageName, 'bundles');
    parsedPackage['fesm2015'] = getBundleName(packageName, 'fesm2015');

    parsedPackage['esm2015'] = srcDirRelative(packageJson, moduleData['esm2015_index']);
    parsedPackage['typings'] = srcDirRelative(packageJson, moduleData['typings']);

    // For now, we point the primary entry points at the fesm files, because of Webpack
    // performance issues with a large number of individual files.
    parsedPackage['module'] = parsedPackage['fesm2015'];
    parsedPackage['es2015'] = parsedPackage['fesm2015'];

    return JSON.stringify(parsedPackage, null, 2);
  }

  // e.g. @angular/common/http/testing -> ../../bundles/common-http-testing.umd.js
  // or   @angular/common/http/testing -> ../../fesm5/http/testing.js
  function getBundleName(packageName: string, dir: string) {
    const parts = packageName.split('/');
    // Remove the scoped package part, like @angular if present
    const nameParts = packageName.startsWith('@') ? parts.splice(1) : parts;
    const relativePath = newArray(nameParts.length - 1, '..').join('/') || '.';
    let basename: string;
    if (dir === 'bundles') {
      basename = nameParts.join('-') + '.umd';
    } else if (nameParts.length === 1) {
      basename = nameParts[0];
    } else {
      basename = nameParts.slice(1).join('/');
    }
    return [relativePath, dir, basename + '.js'].join('/');
  }

  /** Whether the package explicitly sets any of the format properties (like `main`). */
  function hasExplicitFormatProperties(parsedPackage: {[key: string]: string}): boolean {
    return Object.keys(parsedPackage)
        .some(propertyName => knownFormatPackageJsonFields.includes(propertyName));
  }

  /** Creates metadata re-export file for a secondary entry-point. */
  function createMetadataReexportFile(
      entryPointName: string, metadataFile: string, packageName: string) {
    const inputPath = path.join(srcDir, `${entryPointName}.metadata.json`);
    writeFileFromInputPath(inputPath, JSON.stringify({
      '__symbolic': 'module',
      'version': 3,
      'metadata': {},
      'exports':
          [{'from': `${srcDirRelative(inputPath, metadataFile.replace(/.metadata.json$/, ''))}`}],
      'flatModuleIndexRedirect': true,
      'importAs': packageName
    }) + '\n');
  }

  /**
   * Creates a typings (d.ts) re-export file for a secondary-entry point,
   * e.g., `export * from './common/common'`
   */
  function createTypingsReexportFile(entryPointName: string, license: string, typingsFile: string) {
    const inputPath = path.join(srcDir, `${entryPointName}.d.ts`);
    const content = `${license}
export * from '${srcDirRelative(inputPath, typingsFile.replace(/\.d\.tsx?$/, ''))}';
`;
    writeFileFromInputPath(inputPath, content);
  }

  /**
   * Creates a package.json for a secondary entry-point.
   * @param dir The directory under which the package.json should be written.
   * @param entryPointPackageName The full package name for the entry point,
   *     e.g. '@angular/common/http'.
   */
  function createEntryPointPackageJson(dir: string, entryPointPackageName: string) {
    const pkgJson = path.join(srcDir, dir, 'package.json');
    const content = amendPackageJson(pkgJson, {name: entryPointPackageName}, true);
    writeFileFromInputPath(pkgJson, content);
  }

  /**
   * Normalizes the specified path by replacing backslash separators with Posix
   * forward slash separators.
   */
  function normalizeSeparators(path: string): string {
    return path.replace(/\\/g, '/');
  }

  /**
   * Rewires metadata to point to the flattened dts file.
   *
   * @param metadataPath the metadata file path
   * @param typingsPath the typings bundle entrypoint
   */
  function rewireMetadata(metadataPath: string, typingsPath: string): string {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

    let typingsRelativePath =
        normalizeSeparators(path.relative(path.dirname(metadataPath), typingsPath));
    if (!typingsRelativePath.startsWith('..')) {
      typingsRelativePath = `./${typingsRelativePath}`;
    }

    typingsRelativePath = typingsRelativePath.replace('.d.ts', '');

    // the regexp here catches all relative paths such as:
    // ./src/core/foo.d.ts and ../src/core/foo.d.ts
    const relativePathRegex = /\.?\.\/[\w\.\-_\/]+/g;
    if (metadata.exports) {
      // Strip re-exports which are now self-references
      metadata.exports =
          metadata.exports.filter((e: {from: string}) => !e.from.match(relativePathRegex));
    }
    return JSON.stringify(metadata).replace(relativePathRegex, typingsRelativePath);
  }

  /**
   * Strip the named AMD module for compatibility with non-bazel users from typings content
   * @param filePath dts file path
   */
  function readTypingsAndStripAmdModule(filePath: string): string {
    return fs
        .readFileSync(filePath, 'utf-8')
        // Strip the named AMD module for compatibility with non-bazel users
        .replace(/^\/\/\/ <amd-module name=.*\/>[\r\n]+/gm, '');
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

export function newArray<T = any>(size: number): T[];
export function newArray<T>(size: number, value: T): T[];
export function newArray<T>(size: number, value?: T): T[] {
  const list: T[] = [];
  for (let i = 0; i < size; i++) {
    list.push(value!);
  }
  return list;
}
