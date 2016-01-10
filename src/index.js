import _ from 'lodash';
import getCreateDeps from './getCreateDeps';
import LazyBuilder from 'lazy-builder';
import micromatch from 'micromatch';
import path from 'path';
import {createReadStream} from 'streamifier';
import Promise from 'bluebird';

const defaults = {
  include: '**/*.js',
  entries: '**/*.entry.js',
  cwd: process.cwd(),
  transforms: [],
};

export default function () {
  let options, browserifyOptions, Browserify, src;

  // handle varying numbers of arguments
  switch (arguments.length) {
    case 0:
      options = _.assign({}, defaults);
      break;
    case 1:
      const arg = arguments[0];
      if (_.isFunction(arg) || _.isString(arg) || _.isArray(arg)) {
        options = _.assign({}, defaults, {entries: arg});
      }
      else options = _.assign({}, defaults, arg);
      break;
    case 2:
      options = _.assign({}, defaults, arguments[1], {entries: arguments[0]});
      break;
    default:
      throw new TypeError('Invalid options');
  }

  // check for alias option names
  if (options.entry) {
    options.entries = options.entry;
    delete options.entry;
  }
  if (options.extension) {
    options.extensions = options.extension;
    delete options.extension;
  }
  if (options.transform) {
    options.transforms = options.transform;
    delete options.transform;
  }

  // validate and normalize the extensions (make sure they've all got a dot)
  if (options.extensions) {
    if (_.isString(options.extensions)) options.extensions = [options.extensions];

    options.extensions.forEach((item, i) => {
      if (!_.isString(item)) {
        throw new TypeError('options.extensions should be an array of strings, or a single string');
      }

      if (item.length && item.charAt(0) !== '.') options.extensions[i] = '.' + item;
    });
  }

  if (options.transforms && !Array.isArray(options.transforms)) options.transforms = [options.transforms];

  // make a set of all extensions (including the standard two)
  const allExtensions = new Set(['.js', '.json']);
  if (options.extensions) {
    for (const extension of options.extensions) allExtensions.add(extension);
  }

  // create the options that will be used to instantiate every Browserify instance
  browserifyOptions = {
    extensions: options.extensions,
    basedir: options.cwd, // or should this be the source dir?
    debug: options.sourceMap,
    fullPaths: true,
    paths: [path.join(options.cwd, 'node_modules')],
    transform: options.transforms,
  };

  // load browserify
  Browserify = require('browserify'); // eslint-disable-line global-require

  // delete it from the global cache because we're going to monkey-patch it
  delete require.cache[require.resolve('browserify')];

  // prepare filters
  const isIncluded = micromatch.filter(options.include);
  const isEntry = micromatch.filter(options.entries);

  const builder = new LazyBuilder(function (file, contents) {
    // skip non-included files
    if (!isIncluded(file)) return contents;

    // block non-entry modules
    if (!isEntry(file)) return null;

    // monkey-patch Browserify for this one job
    Browserify.prototype._createDeps = getCreateDeps(src, this.importFile);

    // make a browserify instance
    const b = new Browserify(browserifyOptions);

    // add transforms
    // for (const transform of options.transforms) {
    //   b.transform(transform);
    // }

    // browserify expects a stream, not a buffer
    const stream = createReadStream(contents);
    stream.file = path.resolve(src, file); // https://github.com/substack/node-browserify/issues/816
    b.add(stream);


    // bundle it
    return Promise.promisify(b.bundle.bind(b))()
      .then(bundledContents => {
        // output the bundle
        return bundledContents;
      })
      .catch(err => {
        // can't throw a CodeError due to
        // https://github.com/substack/node-browserify/issues/1117
        // TODO: find workaround?
        throw err;
      });
  });

  // return the configured plugin function
  return function tripBrowserify(files) {
    if (!src) src = this.src;

    return builder.build(files);
  };
}
