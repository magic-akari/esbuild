const { installForTests, removeRecursiveSync, writeFileAtomic } = require('./esbuild')
const assert = require('assert')
const path = require('path')
const util = require('util')
const http = require('http')
const url = require('url')
const fs = require('fs')

const readFileAsync = util.promisify(fs.readFile)
const writeFileAsync = util.promisify(fs.writeFile)
const mkdirAsync = util.promisify(fs.mkdir)

const repoDir = path.dirname(__dirname)
const rootTestDir = path.join(repoDir, 'scripts', '.plugin-tests')

function fetch(host, port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const content = Buffer.concat(chunks)
        if (res.statusCode < 200 || res.statusCode > 299) {
          const error = new Error(`${res.statusCode} when fetching ${path}: ${content}`)
          error.statusCode = res.statusCode
          reject(error)
        } else {
          content.headers = res.headers
          resolve(content)
        }
      })
    }).on('error', reject)
  })
}

function fetchUntilSuccessOrTimeout(host, port, path) {
  const seconds = 5
  let timeout
  let stop = false
  const cancel = () => clearTimeout(timeout)
  const promise = Promise.race([
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        stop = true
        reject(new Error(`Waited more than ${seconds} seconds while trying to fetch "http://${host}:${port}${path}"`))
      }, seconds * 1000)
    }),
    (async () => {
      while (!stop) {
        try {
          return await fetch(host, port, path)
        } catch {
        }
      }
    })(),
  ])
  promise.then(cancel, cancel)
  return promise
}

let pluginTests = {
  async noPluginsWithBuildSync({ esbuild }) {
    try {
      esbuild.buildSync({
        entryPoints: [], logLevel: 'silent', plugins: [{
          name: 'name',
          setup() { },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].text, 'Cannot use plugins in synchronous API calls')
      assert.deepStrictEqual(e.warnings, [])
    }
  },

  async emptyArray({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `export default 123`)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async emptyArrayWithBuildSync({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `export default 123`)
    esbuild.buildSync({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async invalidRegExp({ esbuild }) {
    for (const filter of [/x(?=y)/, /x(?!y)/, /x(?<=y)/, /x(?<!y)/, /(x)\1/]) {
      // onResolve
      try {
        await esbuild.build({
          entryPoints: ['invalid.js'],
          write: false,
          plugins: [{
            name: 'name',
            setup(build) {
              build.onResolve({ filter }, () => { })
            },
          }],
        })
        throw new Error(`Expected filter ${filter} to fail`)
      } catch (e) {
        assert.strictEqual(e.message, `[name] "onResolve" filter is not a valid Go regular expression: ${JSON.stringify(filter.source)}`)
      }

      // onLoad
      try {
        await esbuild.build({
          entryPoints: ['invalid.js'],
          write: false,
          plugins: [{
            name: 'name',
            setup(build) {
              build.onLoad({ filter }, () => { })
            },
          }],
        })
        throw new Error(`Expected filter ${filter} to fail`)
      } catch (e) {
        assert.strictEqual(e.message, `[name] "onLoad" filter is not a valid Go regular expression: ${JSON.stringify(filter.source)}`)
      }
    }
  },

  async caseInsensitiveRegExp({ esbuild, testDir }) {
    const inputJs = path.join(testDir, 'in.js')
    await writeFileAsync(inputJs, `export default 123`)

    const inputCpp = path.join(testDir, 'in.CpP')
    await writeFileAsync(inputCpp, `export default 123`)

    // onResolve
    const onResolveResult = await esbuild.build({
      entryPoints: ['example.CpP'],
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /\.c(pp|xx)?$/i }, args => {
            assert.strictEqual(args.path, 'example.CpP')
            return { path: inputJs }
          })
        },
      }],
    })
    assert.strictEqual(onResolveResult.outputFiles.length, 1)
    assert.strictEqual(onResolveResult.outputFiles[0].text, `export default 123;\n`)

    // onLoad
    const onLoadResult = await esbuild.build({
      entryPoints: [inputCpp],
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onLoad({ filter: /\.c(pp|xx)?$/i }, args => {
            assert(args.path.endsWith('in.CpP'))
            return { contents: 'export default true' }
          })
        },
      }],
    })
    assert.strictEqual(onLoadResult.outputFiles.length, 1)
    assert.strictEqual(onLoadResult.outputFiles[0].text, `export default true;\n`)
  },

  async pluginMissingName({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: [],
        logLevel: 'silent',
        plugins: [{
          setup(build) {
          },
        }],
      })
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].text, 'Plugin at index 0 is missing a name')
      assert.deepStrictEqual(e.warnings, [])
    }
  },

  async pluginMissingSetup({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: [],
        logLevel: 'silent',
        plugins: [{
          name: 'x',
        }],
      })
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].pluginName, 'x')
      assert.strictEqual(e.errors[0].text, 'Plugin is missing a setup function')
      assert.deepStrictEqual(e.warnings, [])
    }
  },

  async badPluginProperty({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: [],
        logLevel: 'silent',
        plugins: [{
          name: 'x',
          someRandomProperty: void 0,
          setup(build) {
          },
        }],
      })
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].text, 'Invalid option on plugin "x": "someRandomProperty"')
      assert.deepStrictEqual(e.warnings, [])
    }
  },

  async badPluginOnResolveProperty({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        plugins: [{
          name: 'x',
          setup(build) {
            build.onResolve({ whatIsThis: void 0 }, () => {
            })
          },
        }],
      })
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].text, 'Invalid option in onResolve() call for plugin "x": "whatIsThis"')
      assert.deepStrictEqual(e.warnings, [])
    }

    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        write: false,
        plugins: [{
          name: 'x',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              return '/'
            })
          },
        }],
      })
    } catch (e) {
      assert(e.message.endsWith('ERROR: [plugin: x] Expected onResolve() callback in plugin "x" to return an object'), e.message)
    }

    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        write: false,
        plugins: [{
          name: 'x',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              return { thisIsWrong: void 0 }
            })
          },
        }],
      })
    } catch (e) {
      assert(e.message.endsWith('ERROR: [plugin: x] Invalid option from onResolve() callback in plugin "x": "thisIsWrong"'), e.message)
    }
  },

  async badPluginOnLoadProperty({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        plugins: [{
          name: 'x',
          setup(build) {
            build.onLoad({ whatIsThis: void 0 }, () => {
            })
          },
        }],
      })
    } catch (e) {
      assert.strictEqual(e.message.split('\n')[0], 'Build failed with 1 error:')
      assert.notStrictEqual(e.errors, void 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].text, 'Invalid option in onLoad() call for plugin "x": "whatIsThis"')
      assert.deepStrictEqual(e.warnings, [])
    }

    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        write: false,
        plugins: [{
          name: 'x',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              return { path: 'y', namespace: 'z' }
            })
            build.onLoad({ filter: /.*/ }, () => {
              return ""
            })
          },
        }],
      })
    } catch (e) {
      assert(e.message.endsWith(`ERROR: [plugin: x] Expected onLoad() callback in plugin "x" to return an object`), e.message)
    }

    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        write: false,
        plugins: [{
          name: 'x',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              return { path: 'y', namespace: 'z' }
            })
            build.onLoad({ filter: /.*/ }, () => {
              return { thisIsWrong: void 0 }
            })
          },
        }],
      })
    } catch (e) {
      assert(e.message.endsWith('ERROR: [plugin: x] Invalid option from onLoad() callback in plugin "x": "thisIsWrong"'), e.message)
    }
  },

  async modifyInitialOptions({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.what')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `export default 123`)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'what',
        setup(build) {
          build.initialOptions.loader = { '.what': 'js' }
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async modifyInitialOptionsAsync({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.what')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `export default 123`)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'what',
        async setup(build) {
          await new Promise(r => setTimeout(r, 100))
          build.initialOptions.loader = { '.what': 'js' }
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async basicLoader({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const custom = path.join(testDir, 'example.custom')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from './example.custom'
      export default x
    `)
    await writeFileAsync(custom, ``)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onLoad({ filter: /\.custom$/ }, args => {
            assert.strictEqual(args.path, custom)
            return { contents: 'this is custom', loader: 'text' }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 'this is custom')
  },

  async basicResolver({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const custom = path.join(testDir, 'example.txt')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from 'test'
      export default x
    `)
    await writeFileAsync(custom, `example text`)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^test$/ }, args => {
            assert.strictEqual(args.path, 'test')
            return { path: custom }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 'example text')
  },

  async fibonacciResolverMemoized({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from 'fib(10)'
      export default x
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^fib\((\d+)\)$/ }, args => {
            return { path: args.path, namespace: 'fib' }
          })
          build.onLoad({ filter: /^fib\((\d+)\)$/, namespace: 'fib' }, args => {
            let match = /^fib\((\d+)\)$/.exec(args.path), n = +match[1]
            let contents = n < 2 ? `export default ${n}` : `
              import n1 from 'fib(${n - 1})'
              import n2 from 'fib(${n - 2})'
              export default n1 + n2`
            return { contents }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 55)
  },

  async fibonacciResolverNotMemoized({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from 'fib(10)'
      export default x
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^fib\((\d+)\)/ }, args => {
            return { path: args.path, namespace: 'fib' }
          })
          build.onLoad({ filter: /^fib\((\d+)\)/, namespace: 'fib' }, args => {
            let match = /^fib\((\d+)\)/.exec(args.path), n = +match[1]
            let contents = n < 2 ? `export default ${n}` : `
              import n1 from 'fib(${n - 1}) ${args.path}'
              import n2 from 'fib(${n - 2}) ${args.path}'
              export default n1 + n2`
            return { contents }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 55)
  },

  async resolversCalledInSequence({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const nested = path.join(testDir, 'nested.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from 'test'
      export default x
    `)
    await writeFileAsync(nested, `
      export default 123
    `)
    let trace = []
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [
        {
          name: 'plugin1',
          setup(build) {
            build.onResolve({ filter: /^.*$/ }, () => { trace.push('called first') })
          },
        },
        {
          name: 'plugin2',
          setup(build) {
            build.onResolve({ filter: /^ignore me$/ }, () => { trace.push('not called') })
          },
        },
        {
          name: 'plugin3',
          setup(build) {
            build.onResolve({ filter: /^.*$/ }, () => {
              trace.push('called second')
              return { path: nested }
            })
          },
        },
        {
          name: 'plugin4',
          setup(build) {
            build.onResolve({ filter: /^.*$/ }, () => { trace.push('not called') })
          },
        }
      ],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
    assert.deepStrictEqual(trace, [
      'called first',
      'called second',
    ])
  },

  async loadersCalledInSequence({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const nested = path.join(testDir, 'nested.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from './nested.js'
      export default x
    `)
    await writeFileAsync(nested, `
      export default 123
    `)
    let trace = []
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [
        {
          name: 'plugin1',
          setup(build) {
            build.onLoad({ filter: /^.*$/ }, () => { trace.push('called first') })
          },
        },
        {
          name: 'plugin2',
          setup(build) {
            build.onLoad({ filter: /^.*$/, namespace: 'ignore-me' }, () => { trace.push('not called') })
          },
        },
        {
          name: 'plugin3',
          setup(build) {
            build.onLoad({ filter: /^.*$/, namespace: 'file' }, () => {
              trace.push('called second')
              return { contents: 'export default "abc"' }
            })
          },
        },
        {
          name: 'plugin4',
          setup(build) {
            build.onLoad({ filter: /^.*$/, namespace: 'file' }, () => { trace.push('not called') })
          },
        },
      ],
    })
    const result = require(output)
    assert.strictEqual(result.default, 'abc')
    assert.deepStrictEqual(trace, [
      'called first',
      'called second',
    ])
  },

  async httpRelative({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import x from 'http://example.com/assets/js/example.js'
      export default x
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^http:\/\// }, args => {
            return { path: args.path, namespace: 'http' }
          })
          build.onResolve({ filter: /.*/, namespace: 'http' }, args => {
            return { path: new URL(args.path, args.importer).toString(), namespace: 'http' }
          })
          build.onLoad({ filter: /^http:\/\//, namespace: 'http' }, args => {
            switch (args.path) {
              case 'http://example.com/assets/js/example.js':
                return { contents: `import y from './data/base.js'; export default y` }
              case 'http://example.com/assets/js/data/base.js':
                return { contents: `export default 123` }
            }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async rewriteExternalWithNamespace({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import {exists} from 'extern'
      export default exists
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^extern$/ }, () => {
            return { path: 'fs', external: true, namespace: 'for-testing' }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, fs.exists)
  },

  async rewriteExternalWithoutNamespace({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import {exists} from 'extern'
      export default exists
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^extern$/ }, () => {
            return { path: 'fs', external: true }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, fs.exists)
  },

  async rewriteExternalWithFileNamespace({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const outdir = path.join(testDir, 'out')
    const outdir2 = path.join(testDir, 'out2')
    const target = path.join(outdir2, 'target.js')
    await writeFileAsync(input, `
      import {exists} from 'extern'
      export default exists
    `)
    await mkdirAsync(outdir2, { recursive: true })
    await writeFileAsync(target, `
      module.exports = require('fs')
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outdir,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^extern$/ }, () => {
            return { path: path.join(outdir, 'target'), external: true, namespace: 'file' }
          })
        },
      }],
    })

    // Move the file to show that the output has a relative path
    await fs.promises.rename(path.join(outdir, 'in.js'), path.join(outdir2, 'in.js'))

    const result = require(path.join(outdir2, 'in.js'))
    assert.strictEqual(result.default, fs.exists)
  },

  async resolveDirInFileModule({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    const example = path.join(testDir, 'example.custom')
    const resolveDir = path.join(testDir, 'target')
    const loadme = path.join(resolveDir, 'loadme.js')
    await mkdirAsync(resolveDir)
    await writeFileAsync(input, `
      import value from './example.custom'
      export default value
    `)
    await writeFileAsync(example, `
      export {default} from './loadme'
    `)
    await writeFileAsync(loadme, `
      export default 123
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onLoad({ filter: /\.custom$/ }, async (args) => {
            return { contents: await readFileAsync(args.path), resolveDir }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async resolveWithSideEffectsFalse({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')

    await writeFileAsync(input, `
      import './re-export-unused'
      import {a, b, c} from './re-export-used'
      import './import-unused'
      use([a, b, c])
    `)
    await writeFileAsync(path.join(testDir, 're-export-unused.js'), `
      export {default as a} from 'plugin:unused-false'
      export {default as b} from 'plugin:unused-true'
      export {default as c} from 'plugin:unused-none'
    `)
    await writeFileAsync(path.join(testDir, 're-export-used.js'), `
      export {default as a} from 'plugin:used-false'
      export {default as b} from 'plugin:used-true'
      export {default as c} from 'plugin:used-none'
    `)
    await writeFileAsync(path.join(testDir, 'import-unused.js'), `
      import 'plugin:ignored-false'
      import 'plugin:ignored-true'
      import 'plugin:ignored-none'
    `)

    const result = await esbuild.build({
      entryPoints: [input],
      bundle: true,
      write: false,
      format: 'cjs',
      logLevel: 'error',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^plugin:/ }, args => {
            return {
              path: args.path,
              namespace: 'ns',
              sideEffects:
                args.path.endsWith('-true') ? true :
                  args.path.endsWith('-false') ? false :
                    undefined,
            };
          });
          build.onLoad({ filter: /^plugin:/ }, args => {
            return { contents: `export default use(${JSON.stringify(args.path)})` };
          });
        },
      }],
    })

    // Validate that the unused "sideEffects: false" files were omitted
    const used = [];
    new Function('use', result.outputFiles[0].text)(x => used.push(x));
    assert.deepStrictEqual(used, [
      'plugin:unused-true',
      'plugin:unused-none',

      'plugin:used-false',
      'plugin:used-true',
      'plugin:used-none',

      'plugin:ignored-true',
      'plugin:ignored-none',

      [3, 4, 5],
    ])

    // Check that the warning for "sideEffect: false" imports mentions the plugin
    assert.strictEqual(result.warnings.length, 1)
    assert.strictEqual(result.warnings[0].text,
      'Ignoring this import because "ns:plugin:ignored-false" was marked as having no side effects by plugin "name"')
  },

  async noResolveDirInFileModule({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    const example = path.join(testDir, 'example.custom')
    const resolveDir = path.join(testDir, 'target')
    const loadme = path.join(resolveDir, 'loadme.js')
    await mkdirAsync(resolveDir)
    await writeFileAsync(input, `
      import value from './example.custom'
      export default value
    `)
    await writeFileAsync(example, `
      export {default} from './target/loadme'
    `)
    await writeFileAsync(loadme, `
      export default 123
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onLoad({ filter: /\.custom$/ }, async (args) => {
            return { contents: await readFileAsync(args.path) }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async resolveDirInVirtualModule({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    const resolveDir = path.join(testDir, 'target')
    const loadme = path.join(resolveDir, 'loadme.js')
    await mkdirAsync(resolveDir)
    await writeFileAsync(input, `
      import value from 'virtual'
      export default value
    `)
    await writeFileAsync(loadme, `
      export default 123
    `)
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          let contents = `export {default} from './loadme'`
          build.onResolve({ filter: /^virtual$/ }, () => ({ path: 'virtual', namespace: 'for-testing' }))
          build.onLoad({ filter: /.*/, namespace: 'for-testing' }, () => ({ contents, resolveDir }))
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async noResolveDirInVirtualModule({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const output = path.join(testDir, 'out.js')
    const resolveDir = path.join(testDir, 'target')
    const loadme = path.join(resolveDir, 'loadme.js')
    await mkdirAsync(resolveDir)
    await writeFileAsync(input, `
      import value from 'virtual'
      export default value
    `)
    await writeFileAsync(loadme, `
      export default 123
    `)
    let error
    try {
      await esbuild.build({
        entryPoints: [input],
        bundle: true,
        outfile: output,
        format: 'cjs',
        logLevel: 'silent', plugins: [{
          name: 'name',
          setup(build) {
            let contents = `export {default} from './loadme'`
            build.onResolve({ filter: /^virtual$/ }, () => ({ path: 'virtual', namespace: 'for-testing' }))
            build.onLoad({ filter: /.*/, namespace: 'for-testing' }, () => ({ contents }))
          },
        }],
      })
    } catch (e) {
      error = e
    }
    assert.notStrictEqual(error, void 0)
    if (!Array.isArray(error.errors)) throw error
    assert.strictEqual(error.errors.length, 1)
    assert.strictEqual(error.errors[0].text, `Could not resolve "./loadme"`)
    assert.strictEqual(error.errors[0].notes[0].text,
      `The plugin "name" didn't set a resolve directory for the file "for-testing:virtual", ` +
      `so esbuild did not search for "./loadme" on the file system.`)
  },

  async webAssembly({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    const wasm = path.join(testDir, 'test.wasm')
    const output = path.join(testDir, 'out.js')
    await writeFileAsync(input, `
      import load from './test.wasm'
      export default async (x, y) => (await load()).add(x, y)
    `)
    await writeFileAsync(wasm, Buffer.of(
      // #[wasm_bindgen]
      // pub fn add(x: i32, y: i32) -> i32 { x + y }
      0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60,
      0x02, 0x7F, 0x7F, 0x01, 0x7F, 0x03, 0x02, 0x01, 0x00, 0x05, 0x03, 0x01,
      0x00, 0x11, 0x07, 0x10, 0x02, 0x06, 0x6D, 0x65, 0x6D, 0x6F, 0x72, 0x79,
      0x02, 0x00, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0A, 0x09, 0x01, 0x07,
      0x00, 0x20, 0x00, 0x20, 0x01, 0x6A, 0x0B,
    ))
    await esbuild.build({
      entryPoints: [input],
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /\.wasm$/ }, args => ({
            path: path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, args.path),
            namespace: args.namespace === 'wasm-stub' ? 'wasm-binary' : 'wasm-stub',
          }))
          build.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, async (args) =>
            ({ contents: await readFileAsync(args.path), loader: 'binary' }))
          build.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, async (args) => ({
            contents: `import wasm from ${JSON.stringify(args.path)}
              export default async (imports) =>
                (await WebAssembly.instantiate(wasm, imports)).instance.exports` }))
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(await result.default(103, 20), 123)
  },

  async virtualEntryPoints({ esbuild, testDir }) {
    const result = await esbuild.build({
      entryPoints: ['1', '2', 'a<>:"|?b', 'a/b/c.d.e'],
      bundle: true,
      write: false,
      outdir: testDir,
      format: 'esm',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            return { path: `input ${args.path}`, namespace: 'virtual-ns' }
          })
          build.onLoad({ filter: /.*/, namespace: 'virtual-ns' }, args => {
            return { contents: `console.log(${JSON.stringify(args.path)})` }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles.length, 4)
    assert.strictEqual(result.outputFiles[0].path, path.join(testDir, '1.js'))
    assert.strictEqual(result.outputFiles[1].path, path.join(testDir, '2.js'))
    assert.strictEqual(result.outputFiles[2].path, path.join(testDir, 'a_b.js'))
    assert.strictEqual(result.outputFiles[3].path, path.join(testDir, 'a/b/c.d.js'))
    assert.strictEqual(result.outputFiles[0].text, `// virtual-ns:input 1\nconsole.log("input 1");\n`)
    assert.strictEqual(result.outputFiles[1].text, `// virtual-ns:input 2\nconsole.log("input 2");\n`)
    assert.strictEqual(result.outputFiles[2].text, `// virtual-ns:input a<>:"|?b\nconsole.log('input a<>:"|?b');\n`)
    assert.strictEqual(result.outputFiles[3].text, `// virtual-ns:input a/b/c.d.e\nconsole.log("input a/b/c.d.e");\n`)
  },

  async entryPointFileNamespace({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    let worked = false
    await writeFileAsync(input, 'stuff')
    await esbuild.build({
      entryPoints: [input],
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/, namespace: 'file' }, () => {
            worked = true
          })
        },
      }],
    })
    assert(worked)
  },

  async stdinImporter({ esbuild, testDir }) {
    const output = path.join(testDir, 'out.js')
    await esbuild.build({
      stdin: {
        contents: `import x from "plugin"; export default x`,
        sourcefile: 'stdin-sourcefile',
      },
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^plugin$/ }, args => {
            assert.strictEqual(args.namespace, '')
            assert.strictEqual(args.importer, 'stdin-sourcefile')
            assert.strictEqual(args.resolveDir, '')
            assert.strictEqual(args.path, 'plugin')
            return { path: args.path, namespace: 'worked' }
          })
          build.onLoad({ filter: /.*/, namespace: 'worked' }, () => {
            return { contents: `export default 123` }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async stdinImporterResolveDir({ esbuild, testDir }) {
    const output = path.join(testDir, 'out.js')
    await esbuild.build({
      stdin: {
        contents: `import x from "plugin"; export default x`,
        sourcefile: 'stdin-sourcefile',
        resolveDir: testDir,
      },
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^plugin$/ }, args => {
            assert.strictEqual(args.namespace, 'file')
            assert.strictEqual(args.importer, path.join(testDir, 'stdin-sourcefile'))
            assert.strictEqual(args.resolveDir, testDir)
            assert.strictEqual(args.path, 'plugin')
            return { path: args.path, namespace: 'worked' }
          })
          build.onLoad({ filter: /.*/, namespace: 'worked' }, () => {
            return { contents: `export default 123` }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async stdinAbsoluteImporterResolveDir({ esbuild, testDir }) {
    const output = path.join(testDir, 'out.js')
    await esbuild.build({
      stdin: {
        contents: `import x from "plugin"; export default x`,
        sourcefile: path.join(testDir, 'stdin-sourcefile'),
        resolveDir: testDir,
      },
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /^plugin$/ }, args => {
            assert.strictEqual(args.namespace, 'file')
            assert.strictEqual(args.importer, path.join(testDir, 'stdin-sourcefile'))
            assert.strictEqual(args.resolveDir, testDir)
            assert.strictEqual(args.path, 'plugin')
            return { path: args.path, namespace: 'worked' }
          })
          build.onLoad({ filter: /.*/, namespace: 'worked' }, () => {
            return { contents: `export default 123` }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async stdinRelative({ esbuild, testDir }) {
    const output = path.join(testDir, 'out.js')
    await esbuild.build({
      stdin: {
        contents: `import x from "./stdinRelative.js"; export default x`,
      },
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            assert.strictEqual(args.namespace, '')
            assert.strictEqual(args.importer, '<stdin>')
            assert.strictEqual(args.resolveDir, '')
            assert.strictEqual(args.path, './stdinRelative.js')
            return { path: args.path, namespace: 'worked' }
          })
          build.onLoad({ filter: /.*/, namespace: 'worked' }, () => {
            return { contents: `export default 123` }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async stdinRelativeResolveDir({ esbuild, testDir }) {
    const output = path.join(testDir, 'out', 'out.js')
    await esbuild.build({
      stdin: {
        contents: `import x from "./stdinRelative.js"; export default x`,
        resolveDir: testDir,
      },
      bundle: true,
      outfile: output,
      format: 'cjs',
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            assert.strictEqual(args.namespace, '')
            assert.strictEqual(args.importer, '<stdin>')
            assert.strictEqual(args.resolveDir, testDir)
            assert.strictEqual(args.path, './stdinRelative.js')
            return { path: args.path, namespace: 'worked' }
          })
          build.onLoad({ filter: /.*/, namespace: 'worked' }, () => {
            return { contents: `export default 123` }
          })
        },
      }],
    })
    const result = require(output)
    assert.strictEqual(result.default, 123)
  },

  async externalRequire({ esbuild, testDir }) {
    const externalPlugin = external => ({
      name: 'external',
      setup(build) {
        let escape = text => `^${text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`
        let filter = new RegExp(external.map(escape).join('|'))
        build.onResolve({ filter: /.*/, namespace: 'external' }, args => ({
          path: args.path, external: true
        }))
        build.onResolve({ filter }, args => ({
          path: args.path, namespace: 'external'
        }))
        build.onLoad({ filter: /.*/, namespace: 'external' }, args => ({
          contents: `import * as all from ${JSON.stringify(args.path)}; module.exports = all`
        }))
      },
    })
    const outfile = path.join(testDir, 'out', 'output.mjs')
    await esbuild.build({
      stdin: {
        contents: `const fs = require('fs')
          const url = require('url')
          const path = require('path')
          export default fs.readdirSync(path.dirname(url.fileURLToPath(import.meta.url)))
        `,
      },
      bundle: true,
      outfile,
      format: 'esm',
      plugins: [
        externalPlugin(['fs', 'url', 'path'])
      ],
    })
    const result = await import(url.pathToFileURL(outfile))
    assert.deepStrictEqual(result.default, [path.basename(outfile)])
  },

  async newlineInPath({ esbuild }) {
    // Using a path with a newline shouldn't cause a syntax error when the path is printed in a comment
    for (let nl of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
      let problem = `a b${nl}c d`
      const plugin = {
        name: 'test',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => ({
            path: args.path, namespace: 'test',
          }))
          build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({
            contents: `return ${JSON.stringify(args.path)}`
          }))
        },
      }
      let result = await esbuild.build({
        entryPoints: [problem],
        bundle: true,
        write: false,
        format: 'cjs',
        plugins: [plugin],
      })
      let value = new Function(result.outputFiles[0].text)()
      assert.deepStrictEqual(value, problem)
    }
  },

  async newlineInNamespace({ esbuild }) {
    // Using a namespace with a newline shouldn't cause a syntax error when the namespace is printed in a comment
    for (let nl of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
      let problem = `a b${nl}c d`
      const plugin = {
        name: 'test',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => ({
            path: args.path, namespace: problem,
          }))
          build.onLoad({ filter: /.*/, namespace: problem }, args => ({
            contents: `return ${JSON.stringify(args.namespace)}`
          }))
        },
      }
      let result = await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        format: 'cjs',
        plugins: [plugin],
      })
      let value = new Function(result.outputFiles[0].text)()
      assert.deepStrictEqual(value, problem)
    }
  },

  async transformUndefinedDetailForError({ esbuild }) {
    try {
      await esbuild.transform('x y')
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.deepStrictEqual(e.warnings, [])
      assert.deepStrictEqual(e.errors, [{
        id: '',
        pluginName: '',
        text: 'Expected ";" but found "y"',
        location: {
          file: '<stdin>',
          namespace: '',
          line: 1,
          column: 2,
          length: 1,
          lineText: 'x y',
          suggestion: ';',
        },
        notes: [],
        detail: void 0,
      }])
    }
  },

  async transformUndefinedDetailForWarning({ esbuild }) {
    const result = await esbuild.transform('typeof x == "null"')
    assert.deepStrictEqual(result.warnings, [{
      id: 'impossible-typeof',
      pluginName: '',
      text: 'The "typeof" operator will never evaluate to "null"',
      location: {
        file: '<stdin>',
        namespace: '',
        line: 1,
        column: 12,
        length: 6,
        lineText: 'typeof x == "null"',
        suggestion: '',
      },
      notes: [
        {
          location: null,
          text: 'The expression "typeof x" actually evaluates to "object" in JavaScript, not "null". You need to use "x === null" to test for null.'
        }
      ],
      detail: void 0,
    }])
  },

  async buildUndefinedDetailForError({ esbuild }) {
    try {
      await esbuild.build({
        stdin: { contents: 'x y' },
        write: false,
        logLevel: 'silent',
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.deepStrictEqual(e.warnings, [])
      assert.deepStrictEqual(e.errors, [{
        id: '',
        pluginName: '',
        text: 'Expected ";" but found "y"',
        location: {
          file: '<stdin>',
          namespace: '',
          line: 1,
          column: 2,
          length: 1,
          lineText: 'x y',
          suggestion: ';',
        },
        notes: [],
        detail: void 0,
      }])
    }
  },

  async buildUndefinedDetailForWarning({ esbuild }) {
    const result = await esbuild.build({
      stdin: { contents: 'typeof x == "null"' },
      write: false,
      logLevel: 'silent',
    })
    assert.deepStrictEqual(result.warnings, [{
      id: 'impossible-typeof',
      pluginName: '',
      text: 'The "typeof" operator will never evaluate to "null"',
      location: {
        file: '<stdin>',
        namespace: '',
        line: 1,
        column: 12,
        length: 6,
        lineText: 'typeof x == "null"',
        suggestion: '',
      },
      notes: [
        {
          location: null,
          text: 'The expression "typeof x" actually evaluates to "object" in JavaScript, not "null". You need to use "x === null" to test for null.'
        }
      ],
      detail: void 0,
    }])
  },

  async specificDetailForOnResolvePluginThrowError({ esbuild }) {
    const theError = new Error('theError');
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'the-plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              throw theError;
            })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.warnings.length, 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].pluginName, 'the-plugin')
      assert.strictEqual(e.errors[0].text, 'theError')
      assert.strictEqual(e.errors[0].detail, theError)
    }
  },

  async specificDetailForOnLoadPluginThrowError({ esbuild }) {
    const theError = new Error('theError');
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'the-plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => ({ path: 'abc', namespace: 'xyz' }))
            build.onLoad({ filter: /.*/ }, () => {
              throw theError;
            })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.warnings.length, 0)
      assert.strictEqual(e.errors.length, 1)
      assert.strictEqual(e.errors[0].pluginName, 'the-plugin')
      assert.strictEqual(e.errors[0].text, 'theError')
      assert.strictEqual(e.errors[0].detail, theError)
    }
  },

  async specificDetailForOnResolvePluginReturnError({ esbuild }) {
    const theError = new Error('theError');
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'the-plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => {
              return {
                errors: [{
                  text: 'some error',
                  location: {
                    file: 'file1',
                    namespace: 'ns1',
                    line: 1,
                    column: 2,
                    length: 3,
                    lineText: 'some text',
                    suggestion: '',
                  },
                  notes: [{
                    text: 'some note',
                    location: {
                      file: 'file2',
                      namespace: 'ns2',
                      line: 4,
                      column: 5,
                      length: 6,
                      lineText: 'more text',
                      suggestion: '',
                    },
                  }],
                  detail: theError,
                }],
              };
            })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.warnings.length, 0)
      assert.strictEqual(e.errors.length, 1)
      assert.deepStrictEqual(e.errors[0], {
        id: '',
        pluginName: 'the-plugin',
        text: 'some error',
        location: {
          file: 'ns1:file1',
          namespace: 'ns1',
          line: 1,
          column: 2,
          length: 3,
          lineText: 'some text',
          suggestion: '',
        },
        notes: [{
          text: 'some note',
          location: {
            file: 'ns2:file2',
            namespace: 'ns2',
            line: 4,
            column: 5,
            length: 6,
            lineText: 'more text',
            suggestion: '',
          },
        }],
        detail: theError,
      })
    }
  },

  async specificDetailForOnResolvePluginReturnWarning({ esbuild }) {
    const theError = new Error('theError');
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      logLevel: 'silent',
      plugins: [{
        name: 'the-plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, () => {
            return {
              path: 'abc', namespace: 'xyz', warnings: [{
                pluginName: 'other-plugin',
                text: 'some warning',
                location: {
                  file: 'file1',
                  namespace: 'ns1',
                  line: 1,
                  column: 2,
                  length: 3,
                  lineText: 'some text',
                  suggestion: '',
                },
                notes: [{
                  text: 'some note',
                  location: {
                    file: 'file2',
                    namespace: 'ns2',
                    line: 4,
                    column: 5,
                    length: 6,
                    lineText: 'more text',
                    suggestion: '',
                  },
                }],
                detail: theError,
              }]
            };
          })
          build.onLoad({ filter: /.*/ }, () => ({ contents: '' }))
        },
      }],
    })
    assert.strictEqual(result.warnings.length, 1)
    assert.deepStrictEqual(result.warnings[0], {
      id: '',
      pluginName: 'other-plugin',
      text: 'some warning',
      location: {
        file: 'ns1:file1',
        namespace: 'ns1',
        line: 1,
        column: 2,
        length: 3,
        lineText: 'some text',
        suggestion: '',
      },
      notes: [{
        text: 'some note',
        location: {
          file: 'ns2:file2',
          namespace: 'ns2',
          line: 4,
          column: 5,
          length: 6,
          lineText: 'more text',
          suggestion: '',
        },
      }],
      detail: theError,
    })
  },

  async specificDetailForOnLoadPluginReturnError({ esbuild }) {
    const theError = new Error('theError');
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'the-plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => ({ path: 'abc', namespace: 'xyz' }))
            build.onLoad({ filter: /.*/ }, () => {
              return {
                errors: [{
                  text: 'some error',
                  location: {
                    file: 'file1',
                    namespace: 'ns1',
                    line: 1,
                    column: 2,
                    length: 3,
                    lineText: 'some text',
                    suggestion: '',
                  },
                  notes: [{
                    text: 'some note',
                    location: {
                      file: 'file2',
                      namespace: 'ns2',
                      line: 4,
                      column: 5,
                      length: 6,
                      lineText: 'more text',
                      suggestion: '',
                    },
                  }],
                  detail: theError,
                }],
              };
            })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.warnings.length, 0)
      assert.strictEqual(e.errors.length, 1)
      assert.deepStrictEqual(e.errors[0], {
        id: '',
        pluginName: 'the-plugin',
        text: 'some error',
        location: {
          file: 'ns1:file1',
          namespace: 'ns1',
          line: 1,
          column: 2,
          length: 3,
          lineText: 'some text',
          suggestion: '',
        },
        notes: [{
          text: 'some note',
          location: {
            file: 'ns2:file2',
            namespace: 'ns2',
            line: 4,
            column: 5,
            length: 6,
            lineText: 'more text',
            suggestion: '',
          },
        }],
        detail: theError,
      })
    }
  },

  async specificDetailForOnLoadPluginReturnWarning({ esbuild }) {
    const theError = new Error('theError');
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      logLevel: 'silent',
      plugins: [{
        name: 'the-plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, () => ({ path: 'abc', namespace: 'xyz' }))
          build.onLoad({ filter: /.*/ }, () => {
            return {
              contents: '', warnings: [{
                text: 'some warning',
                location: {
                  file: 'file1',
                  namespace: 'ns1',
                  line: 1,
                  column: 2,
                  length: 3,
                  lineText: 'some text',
                  suggestion: '',
                },
                notes: [{
                  text: 'some note',
                  location: {
                    file: 'file2',
                    namespace: 'ns2',
                    line: 4,
                    column: 5,
                    length: 6,
                    lineText: 'more text',
                    suggestion: '',
                  },
                }],
                detail: theError,
              }],
            };
          })
        },
      }],
    })
    assert.strictEqual(result.warnings.length, 1)
    assert.deepStrictEqual(result.warnings[0], {
      id: '',
      pluginName: 'the-plugin',
      text: 'some warning',
      location: {
        file: 'ns1:file1',
        namespace: 'ns1',
        line: 1,
        column: 2,
        length: 3,
        lineText: 'some text',
        suggestion: '',
      },
      notes: [{
        text: 'some note',
        location: {
          file: 'ns2:file2',
          namespace: 'ns2',
          line: 4,
          column: 5,
          length: 6,
          lineText: 'more text',
          suggestion: '',
        },
      }],
      detail: theError,
    })
  },

  async pluginDataResolveToLoad({ esbuild }) {
    const theObject = {}
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, () => ({
            path: 'abc',
            namespace: 'xyz',
            pluginData: theObject,
          }))
          build.onLoad({ filter: /.*/ }, args => {
            assert.strictEqual(args.pluginData, theObject)
            return { contents: 'foo()' };
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, 'foo();\n')
  },

  async pluginDataResolveToLoadNested({ esbuild }) {
    const theObject = {}
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      bundle: true,
      format: 'esm',
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.path === 'entry') return { path: 'entry', namespace: 'xyz' }
            return {
              path: 'nested',
              namespace: 'xyz',
              pluginData: theObject,
            }
          })
          build.onLoad({ filter: /.*/ }, args => {
            if (args.path === 'entry') return { contents: 'import "nested"' };
            assert.strictEqual(args.pluginData, theObject)
            return { contents: 'foo()' };
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, '// xyz:nested\nfoo();\n')
  },

  async pluginDataLoadToResolve({ esbuild }) {
    const theObject = {}
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args === 'import') {
              assert.strictEqual(args.pluginData, theObject)
              return { external: true }
            }
            return { path: 'abc', namespace: 'xyz' }
          })
          build.onLoad({ filter: /.*/ }, () => ({
            contents: 'import("import")',
            pluginData: theObject,
          }))
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, 'import("import");\n')
  },

  async resolveKindEntryPoint({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              resolveKind = args.kind
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'entry-point')
  },

  async resolveKindImportStmt({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `import 'test'` }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'import-statement')
  },

  async resolveKindRequireCall({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `require('test')` }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'require-call')
  },

  async resolveKindDynamicImport({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `import('test')` }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'dynamic-import')
  },

  async resolveKindRequireResolve({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        platform: 'node',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `require.resolve('test')` }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'require-resolve')
  },

  async resolveKindAtImport({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `@import "test";`, loader: 'css' }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'import-rule')
  },

  async resolveKindComposesFrom({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `.foo { composes: bar from 'entry' }`, loader: 'local-css' }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'composes-from')
  },

  async resolveKindURLToken({ esbuild }) {
    let resolveKind = '<missing>'
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
              if (args.importer === '') return { path: args.path, namespace: 'ns' }
              else resolveKind = args.kind
            })
            build.onLoad({ filter: /.*/, namespace: 'ns' }, () => {
              return { contents: `div { background: url('test') }`, loader: 'css' }
            })
          },
        }],
      })
    } catch (e) {
    }
    assert.strictEqual(resolveKind, 'url-token')
  },

  async warnIfUnusedNoWarning({ esbuild }) {
    const build = await esbuild.build({
      entryPoints: ['entry'],
      bundle: true,
      write: false,
      logLevel: 'silent',
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.importer === '') return { path: args.path, namespace: 'entry' }
            else return { path: args.path, namespace: 'bare-import' }
          })
          build.onLoad({ filter: /.*/, namespace: 'entry' }, () => {
            return {
              contents: `
                import "base64"
                import "binary"
                import "dataurl"
                import "json"
                import "text"
              `,
            }
          })
          build.onLoad({ filter: /.*/, namespace: 'bare-import' }, args => {
            return { contents: `[1, 2, 3]`, loader: args.path }
          })
        },
      }],
    })
    assert.strictEqual(build.warnings.length, 0)
  },

  async onResolvePreserveOriginalEntryPointNameIssue945({ esbuild, testDir }) {
    const build = await esbuild.build({
      entryPoints: ['first'],
      write: false,
      logLevel: 'silent',
      outdir: testDir,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, () => {
            return { path: 'second', namespace: 'what' }
          })
          build.onLoad({ filter: /.*/ }, () => {
            return { contents: `` }
          })
        },
      }],
    })
    assert.strictEqual(build.outputFiles[0].path, path.join(testDir, 'first.js'))
  },

  async dynamicImportDuplicateChunkIssue1099({ esbuild, testDir }) {
    const outdir = path.join(testDir, 'out')
    await mkdirAsync(path.join(testDir, 'hi'), { recursive: true })
    await writeFileAsync(path.join(testDir, 'index.js'), `import x from 'manifest'; console.log(x.name(), x.hi())`)
    await writeFileAsync(path.join(testDir, 'name.js'), `import x from 'manifest'; console.log(x.index(), x.hi())`)
    await writeFileAsync(path.join(testDir, 'hi', 'name.js'), `import x from 'manifest'; console.log(x.index(), x.name())`)
    await esbuild.build({
      entryPoints: [path.join(testDir, 'index.js')],
      outdir,
      bundle: true,
      splitting: true,
      format: 'esm',
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /^manifest$/ }, () => {
            return { path: 'manifest', namespace: 'Manifest' }
          })
          build.onLoad({ namespace: 'Manifest', filter: /.*/ }, () => {
            return {
              resolveDir: testDir,
              contents: `
                export const index = () => import('./index')
                export const name = () => import('./name')
                export const hi = () => import('./hi/name')
                export default {index, name, hi}
              `,
            }
          })
        },
      }],
    })
  },

  async fileLoaderCustomNamespaceIssue1404({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.data')
    const outdir = path.join(testDir, 'out')
    await writeFileAsync(input, `some data`)
    await esbuild.build({
      entryPoints: [path.basename(input)],
      absWorkingDir: testDir,
      logLevel: 'silent',
      outdir,
      assetNames: '[name]',
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /\.data$/ }, args => {
            return {
              path: args.path,
              namespace: 'ns',
            }
          })
          build.onLoad({ filter: /.*/, namespace: 'ns' }, async (args) => {
            const data = await readFileAsync(path.join(testDir, args.path), 'utf8')
            return {
              contents: data.split('').reverse().join(''),
              loader: 'file',
            }
          })
        },
      }],
    })
    assert.strictEqual(await readFileAsync(input, 'utf8'), `some data`)
    assert.strictEqual(require(path.join(outdir, 'in.js')), `./in.data`)
  },

  async esbuildProperty({ esbuild }) {
    let esbuildFromBuild
    await esbuild.build({
      entryPoints: ['xyz'],
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          esbuildFromBuild = build.esbuild
          build.onResolve({ filter: /.*/ }, () => ({ path: 'foo', namespace: 'bar' }))
          build.onLoad({ filter: /.*/ }, () => ({ contents: '' }))
        },
      }],
    })
    assert.deepStrictEqual({ ...esbuildFromBuild }, { ...esbuild })
  },

  async onResolveSuffixWithoutPath({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `works()`)
    const result = await esbuild.build({
      entryPoints: [input],
      logLevel: 'silent',
      write: false,
      plugins: [{
        name: 'the-plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, () => ({ suffix: '?just suffix without path' }))
        },
      }],
    })
    assert.strictEqual(result.warnings.length, 1)
    assert.strictEqual(result.warnings[0].text, `Returning "suffix" doesn't do anything when "path" is empty`)
    assert.strictEqual(result.warnings[0].pluginName, 'the-plugin')
  },

  async onResolveInvalidPathSuffix({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: ['foo'],
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          setup(build) {
            build.onResolve({ filter: /.*/ }, () => ({ path: 'bar', suffix: '%what' }))
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert.strictEqual(e.message, `Build failed with 1 error:
error: Invalid path suffix "%what" returned from plugin (must start with "?" or "#")`)
    }
  },

  async onResolveWithInternalOnLoadAndQuerySuffix({ testDir, esbuild }) {
    const entry = path.join(testDir, 'entry.js')
    await writeFileAsync(entry, `console.log('entry')`)
    const onResolveSet = new Set()
    const onLoadSet = new Set()
    await esbuild.build({
      stdin: {
        resolveDir: testDir,
        contents: `
          import "foo%a"
          import "foo%b"
        `,
      },
      bundle: true,
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            onResolveSet.add({ path: args.path, suffix: args.suffix })
            if (args.path.startsWith('foo%')) {
              return {
                path: entry,
                suffix: '?' + args.path.slice(args.path.indexOf('%') + 1),
              }
            }
          })
          build.onLoad({ filter: /.*/ }, args => {
            onLoadSet.add({ path: args.path, suffix: args.suffix })
          })
        },
      }],
    })
    const order = (a, b) => {
      a = JSON.stringify(a)
      b = JSON.stringify(b)
      return (a > b) - (a < b)
    }
    const observed = JSON.stringify({
      onResolve: [...onResolveSet].sort(order),
      onLoad: [...onLoadSet].sort(order),
    }, null, 2)
    const expected = JSON.stringify({
      onResolve: [
        { path: 'foo%a' },
        { path: 'foo%b' },
      ],
      onLoad: [
        { path: path.join(testDir, 'entry.js'), suffix: '?a' },
        { path: path.join(testDir, 'entry.js'), suffix: '?b' },
      ],
    }, null, 2)
    if (observed !== expected) throw new Error(`Observed ${observed}, expected ${expected}`)
  },

  async onLoadWithInternalOnResolveAndQuerySuffix({ testDir, esbuild }) {
    const entry = path.join(testDir, 'entry.js')
    await writeFileAsync(entry, `console.log('entry')`)
    const onResolveSet = new Set()
    const onLoadSet = new Set()
    await esbuild.build({
      stdin: {
        resolveDir: testDir,
        contents: `
          import "./entry?a"
          import "./entry?b"
        `,
      },
      bundle: true,
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            onResolveSet.add({ path: args.path, suffix: args.suffix })
          })
          build.onLoad({ filter: /.*/ }, args => {
            onLoadSet.add({ path: args.path, suffix: args.suffix })
          })
        },
      }],
    })
    const order = (a, b) => {
      a = JSON.stringify(a)
      b = JSON.stringify(b)
      return (a > b) - (a < b)
    }
    const observed = JSON.stringify({
      onResolve: [...onResolveSet].sort(order),
      onLoad: [...onLoadSet].sort(order),
    }, null, 2)
    const expected = JSON.stringify({
      onResolve: [
        { path: './entry?a' },
        { path: './entry?b' },
      ],
      onLoad: [
        { path: path.join(testDir, 'entry.js'), suffix: '?a' },
        { path: path.join(testDir, 'entry.js'), suffix: '?b' },
      ],
    }, null, 2)
    if (observed !== expected) throw new Error(`Observed ${observed}, expected ${expected}`)
  },

  async externalSideEffectsFalse({ esbuild }) {
    const build = await esbuild.build({
      entryPoints: ['entry'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.importer === '') return { path: args.path, namespace: 'entry' }
            else return { path: args.path, external: true, sideEffects: args.path !== 'noSideEffects' }
          })
          build.onLoad({ filter: /.*/, namespace: 'entry' }, () => {
            return {
              contents: `
                import "sideEffects"
                import "noSideEffects"
              `,
            }
          })
        },
      }],
    })
    assert.strictEqual(build.outputFiles[0].text, `// entry:entry\nimport "sideEffects";\n`)
  },

  async callResolveTooEarlyError({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: [],
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          async setup(build) {
            await build.resolve('foo', { kind: 'entry-point' })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert(e.message.includes('Cannot call "resolve" before plugin setup has completed'), e.message)
    }
  },

  async callResolveTooLateError({ esbuild }) {
    let resolve
    await esbuild.build({
      entryPoints: [],
      plugins: [{
        name: 'plugin',
        async setup(build) {
          resolve = build.resolve
        },
      }],
    })
    try {
      const result = await resolve('foo', { kind: 'entry-point' })
      console.log(result.errors)
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert(e.message.includes('Cannot call \"resolve\" on an inactive build'), e.message)
    }
  },

  async callResolveBadKindError({ esbuild }) {
    try {
      await esbuild.build({
        entryPoints: ['entry'],
        logLevel: 'silent',
        plugins: [{
          name: 'plugin',
          async setup(build) {
            build.onResolve({ filter: /^entry$/ }, async () => {
              return await build.resolve('foo', { kind: 'what' })
            })
          },
        }],
      })
      throw new Error('Expected an error to be thrown')
    } catch (e) {
      assert(e.message.includes('Invalid kind: "what"'), e.message)
    }
  },

  // Test that user options are taken into account
  async callResolveUserOptionsExternal({ esbuild, testDir }) {
    const result = await esbuild.build({
      stdin: { contents: `import "foo"` },
      write: false,
      bundle: true,
      external: ['bar'],
      format: 'esm',
      plugins: [{
        name: 'plugin',
        async setup(build) {
          build.onResolve({ filter: /^foo$/ }, async () => {
            const result = await build.resolve('bar', {
              resolveDir: testDir,
              kind: 'import-statement',
            })
            assert(result.external)
            return { path: 'baz', external: true }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `// <stdin>\nimport "baz";\n`)
  },

  async callResolveBuiltInHandler({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const input = path.join(srcDir, 'input.js')
    await mkdirAsync(srcDir, { recursive: true })
    await writeFileAsync(input, `console.log(123)`)
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /^entry$/ }, async () => {
            return await build.resolve('./' + path.basename(input), {
              resolveDir: srcDir,
              kind: 'import-statement',
            })
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `console.log(123);\n`)
  },

  async callResolvePluginHandler({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const input = path.join(srcDir, 'input.js')
    await mkdirAsync(srcDir, { recursive: true })
    await writeFileAsync(input, `console.log(123)`)
    const result = await esbuild.build({
      entryPoints: ['entry'],
      write: false,
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /^entry$/ }, async () => {
            return await build.resolve('foo', {
              importer: 'foo-importer',
              namespace: 'foo-namespace',
              resolveDir: 'foo-resolveDir',
              pluginData: 'foo-pluginData',
              kind: 'dynamic-import',
            })
          })
          build.onResolve({ filter: /^foo$/ }, async (args) => {
            assert.strictEqual(args.path, 'foo')
            assert.strictEqual(args.importer, 'foo-importer')
            assert.strictEqual(args.namespace, 'foo-namespace')
            assert.strictEqual(args.resolveDir, path.join(process.cwd(), 'foo-resolveDir'))
            assert.strictEqual(args.pluginData, 'foo-pluginData')
            assert.strictEqual(args.kind, 'dynamic-import')
            return { path: input }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `console.log(123);\n`)
  },

  async injectWithVirtualFile({ esbuild, testDir }) {
    const input = path.join(testDir, 'input.js')
    await writeFileAsync(input, `console.log(test)`)
    const result = await esbuild.build({
      entryPoints: [input],
      write: false,
      inject: ['plugin-file'],
      plugins: [{
        name: 'plugin',
        setup(build) {
          build.onResolve({ filter: /^plugin-file$/ }, () => {
            return { namespace: 'plugin', path: 'path' }
          })
          build.onLoad({ filter: /^path$/, namespace: 'plugin' }, () => {
            return { contents: `export let test = 'injected'` }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `var test2 = "injected";\nconsole.log(test2);\n`)
  },

  async tsconfigRawAffectsVirtualFiles({ esbuild }) {
    const result = await esbuild.build({
      entryPoints: ['entry'],
      tsconfigRaw: {
        compilerOptions: {
          jsxFactory: 'jay_ess_ex',
        },
      },
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /entry/ }, () => {
            return { path: 'foo', namespace: 'ns' }
          })
          build.onLoad({ filter: /foo/ }, () => {
            return { loader: 'tsx', contents: 'console.log(<div/>)' }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, 'console.log(/* @__PURE__ */ jay_ess_ex("div", null));\n')
  },

  async importAttributesOnResolve({ esbuild }) {
    const result = await esbuild.build({
      entryPoints: ['entry'],
      bundle: true,
      format: 'esm',
      charset: 'utf8',
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.with.type === 'cheese') return { path: 'cheese', namespace: 'ns' }
            if (args.with.pizza === 'true') return { path: 'pizza', namespace: 'ns' }
            return { path: args.path, namespace: 'ns' }
          })
          build.onLoad({ filter: /.*/ }, args => {
            const entry = `
              import a from 'foo' with { type: 'cheese' }
              import b from 'foo' with { pizza: 'true' }
              console.log(a, b)
            `
            if (args.path === 'entry') return { contents: entry }
            if (args.path === 'cheese') return { contents: `export default "🧀"` }
            if (args.path === 'pizza') return { contents: `export default "🍕"` }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `// ns:cheese
var cheese_default = "🧀";

// ns:pizza
var pizza_default = "🍕";

// ns:entry
console.log(cheese_default, pizza_default);
`)
  },

  async importAttributesOnLoad({ esbuild }) {
    const result = await esbuild.build({
      entryPoints: ['entry'],
      bundle: true,
      format: 'esm',
      charset: 'utf8',
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            return { path: args.path, namespace: 'ns' }
          })
          build.onLoad({ filter: /.*/ }, args => {
            const entry = `
              import a from 'foo' with { type: 'cheese' }
              import b from 'foo' with { pizza: 'true' }
              console.log(a, b)
            `
            if (args.path === 'entry') return { contents: entry }
            if (args.with.type === 'cheese') return { contents: `export default "🧀"` }
            if (args.with.pizza === 'true') return { contents: `export default "🍕"` }
          })
        },
      }],
    })
    assert.strictEqual(result.outputFiles[0].text, `// ns:foo with { type: 'cheese' }
var foo_default = "🧀";

// ns:foo with { pizza: 'true' }
var foo_default2 = "🍕";

// ns:entry
console.log(foo_default, foo_default2);
`)
  },

  async importAttributesOnLoadGlob({ esbuild, testDir }) {
    const entry = path.join(testDir, 'entry.js')
    const foo = path.join(testDir, 'foo.js')
    await writeFileAsync(entry, `
      Promise.all([
        import('./foo' + js, { with: { type: 'cheese' } }),
        import('./foo' + js, { with: { pizza: 'true' } }),
      ]).then(resolve)
    `)
    await writeFileAsync(foo, `export default 123`)
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      charset: 'utf8',
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onLoad({ filter: /.*/ }, args => {
            if (args.with.type === 'cheese') return { contents: `export default "🧀"` }
            if (args.with.pizza === 'true') return { contents: `export default "🍕"` }
          })
        },
      }],
    })
    const callback = new Function('js', 'resolve', result.outputFiles[0].text)
    const [cheese, pizza] = await new Promise(resolve => callback('.js', resolve))
    assert.strictEqual(cheese.default, '🧀')
    assert.strictEqual(pizza.default, '🍕')
  },

  async importAttributesResolve({ esbuild }) {
    const onResolve = []
    const resolve = []

    await esbuild.build({
      entryPoints: [],
      bundle: true,
      format: 'esm',
      charset: 'utf8',
      write: false,
      plugins: [{
        name: 'name',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            onResolve.push(args)
            return { external: true }
          })
          build.onStart(async () => {
            resolve.push(await build.resolve('foo', {
              kind: 'require-call',
              with: { type: 'cheese' },
            }))
            resolve.push(await build.resolve('bar', {
              kind: 'import-statement',
              with: { pizza: 'true' },
            }))
          })
        },
      }],
    })

    assert.strictEqual(onResolve.length, 2)
    assert.strictEqual(onResolve[0].path, 'foo')
    assert.strictEqual(onResolve[0].with.type, 'cheese')
    assert.strictEqual(onResolve[1].path, 'bar')
    assert.strictEqual(onResolve[1].with.pizza, 'true')

    assert.strictEqual(resolve.length, 2)
    assert.strictEqual(resolve[0].path, 'foo')
    assert.strictEqual(resolve[0].external, true)
    assert.strictEqual(resolve[1].path, 'bar')
    assert.strictEqual(resolve[1].external, true)
  },

  async internalCrashIssue3634({ esbuild }) {
    await esbuild.build({
      entryPoints: [],
      bundle: true,
      plugins: [{
        name: 'abc',
        setup(build) {
          build.onStart(async () => {
            const result = await build.resolve('/foo', {
              kind: 'require-call',
              resolveDir: 'bar',
            })
            assert.strictEqual(result.errors.length, 1)
          })
        }
      }],
    })
  },

  async sourceMapNamespacePrefixIssue4078({ esbuild, testDir }) {
    const entry = path.join(testDir, 'entry.js')
    await writeFileAsync(entry, `
      import 'foo'
      console.log('entry')
    `)

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      sourcemap: true,
      write: false,
      outdir: path.join(testDir, 'out'),
      plugins: [{
        name: 'example',
        setup(build) {
          build.onResolve({ filter: /foo/ }, () => {
            return { path: 'lib/foo', namespace: 'mynamespace' }
          })
          build.onLoad({ filter: /foo/, namespace: 'mynamespace' }, () => {
            return { contents: 'console.log("foo")' }
          })
        },
      }],
    })

    assert.strictEqual(result.outputFiles.length, 2)
    const map = result.outputFiles.find(file => file.path.endsWith('.js.map'))
    const json = JSON.parse(map.text)
    assert.deepStrictEqual(json.sources, ['mynamespace:lib/foo', '../entry.js'])
  },
}

const makeRebuildUntilPlugin = () => {
  let onEnd

  return {
    rebuildUntil: (mutator, condition) => new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error('Timeout after 30 seconds')), 30 * 1000)
      onEnd = result => {
        try { if (result && condition(result)) clearTimeout(timeout), resolve(result) }
        catch (e) { clearTimeout(timeout), reject(e) }
      }
      mutator()
    }),

    plugin: {
      name: 'rebuildUntil',
      setup(build) {
        build.onEnd(result => onEnd && onEnd(result))
      },
    },
  }
}

// These tests have to run synchronously
let syncTests = {
  async pluginWithWatchMode({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(srcDir, 'in.js')
    const example = path.join(srcDir, 'example.js')
    await mkdirAsync(srcDir, { recursive: true })
    await writeFileAsync(input, `import {x} from "./example.js"; exports.x = x`)
    await writeFileAsync(example, `export let x = 1`)

    const { rebuildUntil, plugin } = makeRebuildUntilPlugin()
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      format: 'cjs',
      logLevel: 'silent',
      bundle: true,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onLoad({ filter: /example\.js$/ }, async (args) => {
              const contents = await fs.promises.readFile(args.path, 'utf8')
              return { contents }
            })
          },
        },
        plugin,
      ],
    })

    try {
      // First build
      const result = await ctx.rebuild()
      let code = await readFileAsync(outfile, 'utf8')
      let exports = {}
      new Function('exports', code)(exports)
      assert.strictEqual(result.outputFiles, void 0)
      assert.strictEqual(exports.x, 1)
      await ctx.watch()

      // First rebuild: edit
      {
        const result2 = await rebuildUntil(
          () => setTimeout(() => writeFileAtomic(example, `export let x = 2`), 250),
          () => fs.readFileSync(outfile, 'utf8') !== code,
        )
        code = await readFileAsync(outfile, 'utf8')
        exports = {}
        new Function('exports', code)(exports)
        assert.strictEqual(result2.outputFiles, void 0)
        assert.strictEqual(exports.x, 2)
      }
    } finally {
      await ctx.dispose()
    }
  },

  async pluginWithWatchFiles({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const otherDir = path.join(testDir, 'other')
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(srcDir, 'in.js')
    const example = path.join(otherDir, 'example.js')
    await mkdirAsync(srcDir, { recursive: true })
    await mkdirAsync(otherDir, { recursive: true })
    await writeFileAsync(input, `import {x} from "<virtual>"; exports.x = x`)
    await writeFileAsync(example, `export let x = 1`)

    const { rebuildUntil, plugin } = makeRebuildUntilPlugin()
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      format: 'cjs',
      logLevel: 'silent',
      bundle: true,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onResolve({ filter: /^<virtual>$/ }, args => {
              return { path: args.path, namespace: 'ns' }
            })
            build.onLoad({ filter: /^<virtual>$/, namespace: 'ns' }, async (args) => {
              const contents = await fs.promises.readFile(example, 'utf8')
              return { contents, watchFiles: [example] }
            })
          },
        },
        plugin,
      ],
    })

    try {
      // First build
      const result = await ctx.rebuild()
      let code = await readFileAsync(outfile, 'utf8')
      let exports = {}
      new Function('exports', code)(exports)
      assert.strictEqual(result.outputFiles, void 0)
      assert.strictEqual(exports.x, 1)
      await ctx.watch()

      // First rebuild: edit
      {
        const result2 = await rebuildUntil(
          () => setTimeout(() => writeFileAtomic(example, `export let x = 2`), 250),
          () => fs.readFileSync(outfile, 'utf8') !== code,
        )
        code = await readFileAsync(outfile, 'utf8')
        exports = {}
        new Function('exports', code)(exports)
        assert.strictEqual(result2.outputFiles, void 0)
        assert.strictEqual(exports.x, 2)
      }
    } finally {
      await ctx.dispose()
    }
  },

  async pluginWithWatchDir({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const otherDir = path.join(testDir, 'other')
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(srcDir, 'in.js')
    await mkdirAsync(srcDir, { recursive: true })
    await mkdirAsync(otherDir, { recursive: true })
    await writeFileAsync(input, `import {x} from "<virtual>"; exports.x = x`)

    const { rebuildUntil, plugin } = makeRebuildUntilPlugin()
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      format: 'cjs',
      logLevel: 'silent',
      bundle: true,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onResolve({ filter: /^<virtual>$/ }, args => {
              return { path: args.path, namespace: 'ns' }
            })
            build.onLoad({ filter: /^<virtual>$/, namespace: 'ns' }, async () => {
              const entries = await fs.promises.readdir(otherDir, 'utf8')
              return { contents: `export let x = ${entries.length}`, watchDirs: [otherDir] }
            })
          },
        },
        plugin,
      ],
    })

    try {
      const result = await ctx.rebuild()
      let code = await readFileAsync(outfile, 'utf8')
      let exports = {}
      new Function('exports', code)(exports)
      assert.strictEqual(result.outputFiles, void 0)
      assert.strictEqual(exports.x, 0)
      await ctx.watch()

      // First rebuild: edit
      {
        const result2 = await rebuildUntil(
          () => setTimeout(() => writeFileAtomic(path.join(otherDir, 'file.txt'), `...`), 250),
          () => fs.readFileSync(outfile, 'utf8') !== code,
        )
        code = await readFileAsync(outfile, 'utf8')
        exports = {}
        new Function('exports', code)(exports)
        assert.strictEqual(result2.outputFiles, void 0)
        assert.strictEqual(exports.x, 1)
      }
    } finally {
      await ctx.dispose()
    }
  },

  async onStartCallback({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, ``)

    let onStartTimes = 0
    let errorToThrow = null
    let valueToReturn = null

    const ctx = await esbuild.context({
      entryPoints: [input],
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onStart(() => {
              if (errorToThrow) throw errorToThrow
              if (valueToReturn) return valueToReturn
              onStartTimes++
            })
          },
        },
      ],
    })
    try {
      assert.strictEqual(onStartTimes, 0)

      await ctx.rebuild()
      assert.strictEqual(onStartTimes, 1)

      await ctx.rebuild()
      assert.strictEqual(onStartTimes, 2)

      errorToThrow = new Error('throw test')
      try {
        await ctx.rebuild()
        throw new Error('Expected an error to be thrown')
      } catch (e) {
        assert.notStrictEqual(e.errors, void 0)
        assert.strictEqual(e.errors.length, 1)
        assert.strictEqual(e.errors[0].pluginName, 'some-plugin')
        assert.strictEqual(e.errors[0].text, 'throw test')
      } finally {
        errorToThrow = null
      }

      valueToReturn = { errors: [{ text: 'return test', location: { file: 'foo.js', line: 2 } }] }
      try {
        await ctx.rebuild()
        throw new Error('Expected an error to be thrown')
      } catch (e) {
        assert.notStrictEqual(e.errors, void 0)
        assert.strictEqual(e.errors.length, 1)
        assert.strictEqual(e.errors[0].pluginName, 'some-plugin')
        assert.strictEqual(e.errors[0].text, 'return test')
        assert.notStrictEqual(e.errors[0].location, null)
        assert.strictEqual(e.errors[0].location.file, 'foo.js')
        assert.strictEqual(e.errors[0].location.line, 2)
      } finally {
        valueToReturn = null
      }

      assert.strictEqual(onStartTimes, 2)
      valueToReturn = new Promise(resolve => setTimeout(() => {
        onStartTimes++
        resolve()
      }, 500))
      await ctx.rebuild()
      assert.strictEqual(onStartTimes, 3)
      valueToReturn = null
    } finally {
      await ctx.dispose()
    }
  },

  async onStartCallbackWithDelay({ esbuild }) {
    await esbuild.build({
      entryPoints: ['foo'],
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            let isStarted = false
            build.onStart(async () => {
              await new Promise(r => setTimeout(r, 1000))
              isStarted = true
            })

            // Verify that "onStart" is finished before "onResolve" and "onLoad" run
            build.onResolve({ filter: /foo/ }, () => {
              assert.strictEqual(isStarted, true)
              return { path: 'foo', namespace: 'foo' }
            })
            build.onLoad({ filter: /foo/ }, () => {
              assert.strictEqual(isStarted, true)
              return { contents: '' }
            })
          },
        },
      ],
    })
  },

  async onEndCallback({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, ``)

    let onEndTimes = 0
    let errorToThrow = null
    let valueToReturn = null
    let mutateFn = null

    const ctx = await esbuild.context({
      entryPoints: [input],
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onEnd(result => {
              if (errorToThrow) throw errorToThrow
              if (valueToReturn) return valueToReturn
              if (mutateFn) mutateFn(result)
              onEndTimes++
            })
          },
        },
      ],
    })
    try {
      assert.strictEqual(onEndTimes, 0)

      await ctx.rebuild()
      assert.strictEqual(onEndTimes, 1)

      await ctx.rebuild()
      assert.strictEqual(onEndTimes, 2)

      errorToThrow = new Error('throw test')
      try {
        await ctx.rebuild()
        throw new Error('Expected an error to be thrown')
      } catch (e) {
        assert.notStrictEqual(e.errors, void 0)
        assert.strictEqual(e.errors.length, 1)
        assert.strictEqual(e.errors[0].pluginName, 'some-plugin')
        assert.strictEqual(e.errors[0].text, 'throw test')
      } finally {
        errorToThrow = null
      }

      assert.strictEqual(onEndTimes, 2)
      valueToReturn = new Promise(resolve => setTimeout(() => {
        onEndTimes++
        resolve()
      }, 500))
      await ctx.rebuild()
      assert.strictEqual(onEndTimes, 3)
      valueToReturn = null

      mutateFn = result => result.warnings.push(true)
      const result2 = await ctx.rebuild()
      assert.deepStrictEqual(result2.warnings, [true])
      mutateFn = () => { }
      const result3 = await ctx.rebuild()
      assert.deepStrictEqual(result3.warnings, [])

      // Adding an error this way does not fail the build (we don't scan the build object for modifications)
      mutateFn = result => result.errors.push({ text: 'test failure' })
      await ctx.rebuild()
      mutateFn = () => { }

      // Instead, plugins should return any additional errors from the "onEnd" callback itself
      valueToReturn = { errors: [{ text: 'test failure 2' }] }
      try {
        await ctx.rebuild()
        throw new Error('Expected an error to be thrown')
      } catch (e) {
        assert.notStrictEqual(e.errors, void 0)
        assert.strictEqual(e.errors.length, 1)
        assert.strictEqual(e.errors[0].pluginName, 'some-plugin')
        assert.strictEqual(e.errors[0].text, 'test failure 2')
        assert.strictEqual(e.errors[0].location, null)
      }
    } finally {
      await ctx.dispose()
    }
  },

  async onEndCallbackMutateContents({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `x=y`)

    let onEndTimes = 0

    const result = await esbuild.build({
      entryPoints: [input],
      write: false,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onEnd(result => {
              onEndTimes++

              assert.deepStrictEqual(result.outputFiles[0].contents, new Uint8Array([120, 32, 61, 32, 121, 59, 10]))
              assert.deepStrictEqual(result.outputFiles[0].text, 'x = y;\n')

              result.outputFiles[0].contents = new Uint8Array([120, 61, 121])
              assert.deepStrictEqual(result.outputFiles[0].contents, new Uint8Array([120, 61, 121]))
              assert.deepStrictEqual(result.outputFiles[0].text, 'x=y')

              result.outputFiles[0].contents = new Uint8Array([121, 61, 120])
              assert.deepStrictEqual(result.outputFiles[0].contents, new Uint8Array([121, 61, 120]))
              assert.deepStrictEqual(result.outputFiles[0].text, 'y=x')
            })
          },
        },
      ],
    })

    assert.deepStrictEqual(onEndTimes, 1)
    assert.deepStrictEqual(result.outputFiles.length, 1)
    assert.deepStrictEqual(result.outputFiles[0].contents, new Uint8Array([121, 61, 120]))
    assert.deepStrictEqual(result.outputFiles[0].text, 'y=x')
  },

  async onStartOnEndWatchMode({ esbuild, testDir }) {
    const srcDir = path.join(testDir, 'src')
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(srcDir, 'in.js')
    const example = path.join(srcDir, 'example.js')
    await mkdirAsync(srcDir, { recursive: true })
    await writeFileAsync(input, `import {x} from "./example.js"; exports.x = x`)
    await writeFileAsync(example, `export let x = 1`)

    let onStartCalls = 0
    let onEndCalls = 0

    const { rebuildUntil, plugin } = makeRebuildUntilPlugin()
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      format: 'cjs',
      logLevel: 'silent',
      bundle: true,
      metafile: true,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onStart(() => {
              onStartCalls++
            })
            build.onEnd(result => {
              assert.notStrictEqual(result.metafile, void 0)
              onEndCalls++
            })

            build.onLoad({ filter: /example\.js$/ }, async (args) => {
              const contents = await fs.promises.readFile(args.path, 'utf8')
              return { contents }
            })
          },
        },
        plugin,
      ],
    })

    try {
      assert.strictEqual(onStartCalls, 0)
      assert.strictEqual(onEndCalls, 0)

      const result = await rebuildUntil(
        () => ctx.watch(),
        () => true,
      )

      assert.notStrictEqual(onStartCalls, 0)
      assert.notStrictEqual(onEndCalls, 0)

      const onStartAfterWatch = onStartCalls
      const onEndAfterWatch = onEndCalls

      let code = await readFileAsync(outfile, 'utf8')
      let exports = {}
      new Function('exports', code)(exports)
      assert.strictEqual(result.outputFiles, void 0)
      assert.strictEqual(exports.x, 1)

      // First rebuild: edit
      {
        const result2 = await rebuildUntil(
          () => setTimeout(() => writeFileAtomic(example, `export let x = 2`), 250),
          () => fs.readFileSync(outfile, 'utf8') !== code,
        )
        code = await readFileAsync(outfile, 'utf8')
        exports = {}
        new Function('exports', code)(exports)
        assert.strictEqual(result2.outputFiles, void 0)
        assert.strictEqual(exports.x, 2)
      }

      assert.notStrictEqual(onStartCalls, onStartAfterWatch)
      assert.notStrictEqual(onEndCalls, onEndAfterWatch)
    } finally {
      await ctx.dispose()
    }
  },

  async pluginServeWriteTrueOnEnd({ esbuild, testDir }) {
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `console.log(1+2`)

    let latestResult
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      logLevel: 'silent',
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onEnd(result => {
              latestResult = result
            })
          },
        },
      ],
    })

    try {
      const server = await ctx.serve()

      // Fetch once
      try {
        await fetch(server.hosts[0], server.port, '/out.js')
        throw new Error('Expected an error to be thrown')
      } catch (err) {
        assert.strictEqual(err.statusCode, 503)
      }
      assert.strictEqual(latestResult.errors.length, 1)
      assert.strictEqual(latestResult.errors[0].text, 'Expected ")" but found end of file')

      // Fix the error
      await writeFileAsync(input, `console.log(1+2)`)

      // Fetch again
      const buffer = await fetchUntilSuccessOrTimeout(server.hosts[0], server.port, '/out.js')
      assert.strictEqual(buffer.toString(), 'console.log(1 + 2);\n')
      assert.strictEqual(latestResult.errors.length, 0)
      assert.strictEqual(latestResult.outputFiles, undefined)
      assert.strictEqual(fs.readFileSync(outfile, 'utf8'), 'console.log(1 + 2);\n')
    } finally {
      await ctx.dispose()
    }
  },

  async pluginServeWriteFalseOnEnd({ esbuild, testDir }) {
    const outfile = path.join(testDir, 'out.js')
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `console.log(1+2`)

    let latestResult
    const ctx = await esbuild.context({
      entryPoints: [input],
      outfile,
      logLevel: 'silent',
      write: false,
      plugins: [
        {
          name: 'some-plugin',
          setup(build) {
            build.onEnd(result => {
              latestResult = result
            })
          },
        },
      ],
    })

    try {
      const server = await ctx.serve()

      // Fetch once
      try {
        await fetch(server.hosts[0], server.port, '/out.js')
        throw new Error('Expected an error to be thrown')
      } catch (err) {
        assert.strictEqual(err.statusCode, 503)
      }
      assert.strictEqual(latestResult.errors.length, 1)
      assert.strictEqual(latestResult.errors[0].text, 'Expected ")" but found end of file')
      assert.strictEqual(latestResult.outputFiles.length, 0)

      // Fix the error
      await writeFileAsync(input, `console.log(1+2)`)

      // Fetch again
      const buffer = await fetchUntilSuccessOrTimeout(server.hosts[0], server.port, '/out.js')
      assert.strictEqual(buffer.toString(), 'console.log(1 + 2);\n')
      assert.strictEqual(latestResult.errors.length, 0)
      assert.strictEqual(latestResult.outputFiles.length, 1)
      assert.strictEqual(latestResult.outputFiles[0].text, 'console.log(1 + 2);\n')
      assert.strictEqual(fs.existsSync(outfile), false)
    } finally {
      await ctx.dispose()
    }
  },

  async pluginOnDisposeAfterSuccessfulBuild({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `1+2`)

    let onDisposeCalled
    let onDisposePromise = new Promise(resolve => onDisposeCalled = resolve)
    await esbuild.build({
      entryPoints: [input],
      write: false,
      plugins: [{
        name: 'x', setup(build) {
          build.onDispose(onDisposeCalled)
        }
      }]
    })
    await onDisposePromise
  },

  async pluginOnDisposeAfterFailedBuild({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')

    let onDisposeCalled
    let onDisposePromise = new Promise(resolve => onDisposeCalled = resolve)
    try {
      await esbuild.build({
        entryPoints: [input],
        write: false,
        logLevel: 'silent',
        plugins: [{
          name: 'x', setup(build) {
            build.onDispose(onDisposeCalled)
          }
        }]
      })
      throw new Error('Expected an error to be thrown')
    } catch (err) {
      if (!err.errors || err.errors.length !== 1)
        throw err
    }
    await onDisposePromise
  },

  async pluginOnDisposeWithUnusedContext({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `1+2`)

    let onDisposeCalled
    let onDisposePromise = new Promise(resolve => onDisposeCalled = resolve)
    let ctx = await esbuild.context({
      entryPoints: [input],
      write: false,
      plugins: [{
        name: 'x', setup(build) {
          build.onDispose(onDisposeCalled)
        }
      }]
    })
    await ctx.dispose()
    await onDisposePromise
  },

  async pluginOnDisposeWithRebuild({ esbuild, testDir }) {
    const input = path.join(testDir, 'in.js')
    await writeFileAsync(input, `1+2`)

    let onDisposeCalled
    let onDisposeWasCalled = false
    let onDisposePromise = new Promise(resolve => {
      onDisposeCalled = () => {
        onDisposeWasCalled = true
        resolve()
      }
    })
    let ctx = await esbuild.context({
      entryPoints: [input],
      write: false,
      plugins: [{
        name: 'x', setup(build) {
          build.onDispose(onDisposeCalled)
        }
      }]
    })

    let result = await ctx.rebuild()
    assert.strictEqual(result.outputFiles.length, 1)
    assert.strictEqual(onDisposeWasCalled, false)

    await ctx.dispose()
    await onDisposePromise
    assert.strictEqual(onDisposeWasCalled, true)
  },
}

async function main() {
  const esbuild = installForTests()

  // Create a fresh test directory
  removeRecursiveSync(rootTestDir)
  fs.mkdirSync(rootTestDir)

  // Time out these tests after 5 minutes. This exists to help debug test hangs in CI.
  let minutes = 5
  let timeout = setTimeout(() => {
    console.error(`❌ plugin tests timed out after ${minutes} minutes, exiting...`)
    process.exit(1)
  }, minutes * 60 * 1000)

  // Run all tests concurrently
  const runTest = async ([name, fn]) => {
    let testDir = path.join(rootTestDir, name)
    try {
      await mkdirAsync(testDir)
      await fn({ esbuild, testDir })
      removeRecursiveSync(testDir)
      return true
    } catch (e) {
      console.error(`❌ ${name}: ${e && e.message || e}`)
      return false
    }
  }
  const tests = Object.entries(pluginTests)
  let allTestsPassed = (await Promise.all(tests.map(runTest))).every(success => success)

  for (let test of Object.entries(syncTests)) {
    if (!await runTest(test)) {
      allTestsPassed = false
    }
  }

  if (!allTestsPassed) {
    console.error(`❌ plugin tests failed`)
    process.exit(1)
  } else {
    console.log(`✅ plugin tests passed`)
    removeRecursiveSync(rootTestDir)
  }

  clearTimeout(timeout);
}

main().catch(e => setTimeout(() => { throw e }))
