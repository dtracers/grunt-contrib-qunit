/*
 * grunt-contrib-qunit
 * http://gruntjs.com/
 *
 * Copyright (c) 2013 "Cowboy" Ben Alman, contributors
 * Licensed under the MIT license.
 */

'use strict';

module.exports = function(grunt) {

  // Nodejs libs.
  var path = require('path');
  var url = require('url');

  // External lib.
  var phantomjs = require('grunt-lib-phantomjs').init(grunt);
  var selenium = require('selenium-standalone');
  var webdriverio = require('webdriverio');
  var browserevent = require('browserevent');

  // Keep track of the last-started module, test and status.
  var options, currentModule, currentTest, status;
  // Keep track of the last-started test(s).
  var unfinished = {};

  // Get an asset file, local to the root of the project.
  var asset = path.join.bind(null, __dirname, '..');

  // Allow an error message to retain its color when split across multiple lines.
  var formatMessage = function(str) {
    return String(str).split('\n').map(function(s) { return s.magenta; }).join('\n');
  };

  // If options.force then log an error, otherwise exit with a warning
  var warnUnlessForced = function (message) {
    if (options && options.force) {
      grunt.log.error(message);
    } else {
      grunt.warn(message);
    }
  };

  // Keep track of failed assertions for pretty-printing.
  var failedAssertions = [];
  var logFailedAssertions = function() {
    var assertion;
    // Print each assertion error.
    while (assertion = failedAssertions.shift()) {
      grunt.verbose.or.error(assertion.testName);
      grunt.log.error('Message: ' + formatMessage(assertion.message));
      if (assertion.actual !== assertion.expected) {
        grunt.log.error('Actual: ' + formatMessage(assertion.actual));
        grunt.log.error('Expected: ' + formatMessage(assertion.expected));
      }
      if (assertion.source) {
        grunt.log.error(assertion.source.replace(/ {4}(at)/g, '  $1'));
      }
      grunt.log.writeln();
    }
  };

  /**
   * Exits the headless browser.
   */
  function exit(client, options) {
    if (options.driver === 'phantomjs') {
      client.halt();
    } else if (options.driver === 'webdriverio') {
      client.end();
    }
  }

  function loadHooks(client, options) {
    var on;
    if (options.driver === 'phantomjs') {
      on = client.on.bind(client);
    } else if (options.driver === 'webdriverio') {
      // by passing the client object as argument the module enhances it with
      // the `addEventListener` and `removeEventListener` command
      browserevent.init(client);
      on = function(eventName, func) {
        client.addEventListener(eventName, '#qunit', func);
      };
    }
    // QUnit hooks.
    on('qunit.moduleStart', function(name) {
      unfinished[name] = true;
      currentModule = name;
    });

    console.log('first hook loaded');

    on('qunit.moduleDone', function(name/*, failed, passed, total*/) {
      delete unfinished[name];
    });

    on('qunit.log', function(result, actual, expected, message, source) {
      if (!result) {
        failedAssertions.push({
          actual: actual, expected: expected, message: message, source: source,
          testName: currentTest
        });
      }
    });

    on('qunit.testStart', function(name) {
      currentTest = (currentModule ? currentModule + ' - ' : '') + name;
      grunt.verbose.write(currentTest + '...');
    });

    on('qunit.testDone', function(name, failed/*, passed, total*/) {
      // Log errors if necessary, otherwise success.
      if (failed > 0) {
        // list assertions
        if (grunt.option('verbose')) {
          grunt.log.error();
          logFailedAssertions();
        } else {
          grunt.log.write('F'.red);
        }
      } else {
        grunt.verbose.ok().or.write('.');
      }
    });

    on('done', function(failed, passed, total, duration) {
      console.log('i think this worked?');
      grunt.log.error('HEY I FINISHED!');
      exit(client, options);
      status.failed += failed;
      status.passed += passed;
      status.total += total;
      status.duration += duration;
      // Print assertion errors here, if verbose mode is disabled.
      if (!grunt.option('verbose')) {
        if (failed > 0) {
          grunt.log.writeln();
          logFailedAssertions();
        } else if (total === 0) {
          warnUnlessForced('0/0 assertions ran (' + duration + 'ms)');
        } else {
          grunt.log.ok();
        }
      }
    });

    // Re-broadcast qunit events on grunt.event.
   on('qunit.*', function() {
      var args = [this.event].concat(grunt.util.toArray(arguments));
      grunt.event.emit.apply(grunt.event, args);
    });

    // Built-in error handlers.
    on('fail.load', function(url) {
      exit(client, options);
      grunt.verbose.write('...');
      grunt.event.emit('qunit.fail.load', url);
      grunt.log.error('PhantomJS unable to load "' + url + '" URI.');
      status.failed += 1;
      status.total += 1;
    });

    on('fail.timeout', function() {
      exit(client, options);
      grunt.log.writeln();
      grunt.event.emit('qunit.fail.timeout');
      grunt.log.error('PhantomJS timed out, possibly due to a missing QUnit start() call.');
      status.failed += 1;
      status.total += 1;
    });

    on('error.onError', function (msg, stackTrace) {
      grunt.event.emit('qunit.error.onError', msg, stackTrace);
      grunt.log.warn('PhantomJS error:\n', msg, '\n', stackTrace);
    });

    // Pass-through console.log statements.
    if (options.console) {
      on('console', console.log.bind(console));
    }
  }

  grunt.registerMultiTask('qunit', 'Run QUnit unit tests in a headless PhantomJS instance.', function() {
    // Merge task-specific and/or target-specific options with these defaults.
    options = this.options({
      // Default PhantomJS timeout.
      timeout: 5000,
      // QUnit-PhantomJS bridge file to be injected.
      inject: asset('phantomjs/bridge.js'),
      // Explicit non-file URLs to test.
      urls: [],
      force: false,
      // Connect phantomjs console output to grunt output
      console: true,
      // Do not use an HTTP base by default
      httpBase: false,

      driver: 'phantomjs'
    });

    var urls;

    if (options.httpBase) {
      //If URLs are explicitly referenced, use them still
      urls = options.urls;
      // Then create URLs for the src files
      this.filesSrc.forEach(function(testFile) {
        urls.push(options.httpBase + '/' + testFile);
      });
    } else {
      // Combine any specified URLs with src files.
      urls = options.urls.concat(this.filesSrc);
    }

    if (options.noGlobals) {
      // Append a noglobal query string param to all urls
      var parsed;
      urls = urls.map(function(testUrl) {
        parsed = url.parse(testUrl, true);
        parsed.query.noglobals = "";
        delete parsed.search;
        return url.format(parsed);
      });
    }

    var client;
    if (options.driver === 'phantomjs') {
      client = phantomjs;
      loadHooks(client, options);
    } else if (options.driver === 'webdriverio') {
      // deferred till the creation of each individual item.
    }

    console.log('Driver that was loaded', client);

    if (options.driver === 'webdriverio2') {
      selenium.start();
    }

    // This task is asynchronous.
    var done = this.async();

    // Reset status.
    status = {failed: 0, passed: 0, total: 0, duration: 0};

    // Process each filepath in-order.
    grunt.util.async.forEachSeries(urls, function(url, next) {
      grunt.verbose.subhead('Testing ' + url + ' ').or.write('Testing ' + url + ' ');

      // Reset current module.
      currentModule = null;

      // Launch PhantomJS.
      grunt.event.emit('qunit.spawn', url);
      if (options.driver === 'phantomjs') {
        phantomjs.spawn(url, {
          // Additional PhantomJS options.
          options: options,
          // Do stuff when done.
          done: function(err) {
            if (err) {
              // If there was an error, abort the series.
              done();
            } else {
              // Otherwise, process next url.
              next();
            }
          },
        });
      } else if (options.driver === 'webdriverio') {
        client = webdriverio.remote(options).init();
        client.url(url);
        loadHooks(client, options);
        console.log('hooks loaded');
        client.pause(3000).execute(function() {
          /* jshint ignore:start */
          QUnit.done(function(event) {
            var customEvent = new CustomEvent('done', event);
            // Dispatch the event.
            var element = document.body.querySelector('#qunit');
            element.dispatchEvent(customEvent);
          });

          QUnit.start();
          /* jshint ignore:end */
        });
        client.title(function(err, res) {
              console.log('Title was: ' + res.value);
          });
          /*
          .end(function(err) {
            if (err) {
              // If there was an error, abort the series.
              done();
            } else {
              // Otherwise, process next url.
              next();
            }
          });
          */
      }
    },
    // All tests have been run.
    function() {
      // Log results.
      if (status.failed > 0) {
        warnUnlessForced(status.failed + '/' + status.total +
            ' assertions failed (' + status.duration + 'ms)');
      } else if (status.total === 0) {
        warnUnlessForced('0/0 assertions ran (' + status.duration + 'ms)');
      } else {
        grunt.verbose.writeln();
        grunt.log.ok(status.total + ' assertions passed (' + status.duration + 'ms)');
      }
      // All done!
      done(status.failed === 0);
    });
  });

};
