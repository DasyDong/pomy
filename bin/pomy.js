#!/usr/bin/env node

'use strict';
var gutil = require('gulp-util');
var prettyTime = require('pretty-hrtime');
var chalk = require('chalk');
var semver = require('semver');
var archy = require('archy');
var Liftoff = require('liftoff');
var tildify = require('tildify');
var v8flags = require('v8flags');
var completion = require('../util/completion');
var argv = require('minimist')(process.argv.slice(2));
var taskTree = require('../util/task-tree');

// Set env var for ORIGINAL cwd
// before anything touches it
process.env.INIT_CWD = process.cwd();

var cli = new Liftoff({
  name: 'pomy',
  completions: completion,
  v8flags: v8flags,
  processTitle: 'pomy',
  moduleName: 'pomy',
  configName: 'pomy',
  extensions: {
    '.json': null
  }
});

// Exit with 0 or 1
var failed = false;
process.once('exit', function(code) {
  if (code === 0 && failed) {
    process.exit(1);
  }
});

// Parse those args m8
var cliPackage = require('../package');
var versionFlag = argv.v || argv.version;
var tasksFlag = argv.T || argv.tasks;
var tasks = argv._;
var toRun = tasks.length ? tasks : ['default'];

// This is a hold-over until we have a better logging system
// with log levels
var simpleTasksFlag = argv['tasks-simple'];
var shouldLog = !argv.silent && !simpleTasksFlag;

if (!shouldLog) {
  gutil.log = function() {};
}

cli.on('require', function(name) {
  gutil.log('Requiring external module', chalk.magenta(name));
});

cli.on('requireFail', function(name) {
  gutil.log(chalk.red('Failed to load external module'), chalk.magenta(name));
});

cli.on('respawn', function(flags, child) {
  var nodeFlags = chalk.magenta(flags.join(', '));
  var pid = chalk.magenta(child.pid);
  gutil.log('Node flags detected:', nodeFlags);
  gutil.log('Respawned to PID:', pid);
});

cli.launch({
  cwd: argv.cwd,
  configPath: argv.configPath,
  require: argv.require,
  completion: argv.completion,
}, handleArguments);

// The actual logic
function handleArguments(env) {

  if (versionFlag && tasks.length === 0) {
    gutil.log('CLI version', cliPackage.version);
    if (env.modulePackage && typeof env.modulePackage.version !== 'undefined') {
      gutil.log('Local version', env.modulePackage.version);
    }
    process.exit(0);
  }

  var archetype = false;
  if (tasks.length === 1 && tasks[0].indexOf('archetype:') === 0) {
    archetype = true;
  }

  if (!env.modulePath) {
    gutil.log(
      chalk.red('Local pomy not found in'),
      chalk.magenta(tildify(env.cwd))
    );
    gutil.log(chalk.red('Try running: npm install pomy'));
    process.exit(1);
  }

  if (!archetype && !env.configPath) {
    gutil.log(chalk.red('No pomy.json found'));
    process.exit(1);
  }

  // Check for semver difference between cli and local installation
  if (semver.gt(cliPackage.version, env.modulePackage.version)) {
    gutil.log(chalk.red('Warning: pomy version mismatch:'));
    gutil.log(chalk.red('Global pomy is', cliPackage.version));
    gutil.log(chalk.red('Local pomy is', env.modulePackage.version));
  }

  // Chdir before requiring pomy.json to make sure
  // we let them chdir as needed
  if (process.cwd() !== env.cwd) {
    process.chdir(env.cwd);
    gutil.log(
      'Working directory changed to',
      chalk.magenta(tildify(env.cwd))
    );
  }

  // This is what actually loads up the pomy.json
  // require(env.configPath);
  if (!archetype) {
    gutil.log('Using pomy.json', chalk.magenta(tildify(env.configPath)));
  }

  var pomyInst = require(env.modulePath);
  logEvents(pomyInst);

  process.nextTick(function() {
    if (simpleTasksFlag) {
      return logTasksSimple(env, pomyInst);
    }
    if (tasksFlag) {
      return logTasks(env, pomyInst);
    }

    if (tasks.length > 1) {
      switch (tasks[0]) {
        case 'install':
        case 'uninstall':
          toRun = ['bower:' + tasks[0]];
          break;
        case 'bower:install':
        case 'bower:uninstall':
          toRun = [tasks[0]];
        case 'update':
        case 'bower:update':
          toRun = tasks.slice(0, 1);
          break;
        default:
          break;
      }
    }
    pomyInst.start.apply(pomyInst, toRun);
  });
}

function logTasks(env, localGulp) {
  var tree = taskTree(localGulp.tasks);
  tree.label = 'Tasks for ' + chalk.magenta(tildify(env.configPath));
  archy(tree)
    .split('\n')
    .forEach(function(v) {
      if (v.trim().length === 0) {
        return;
      }
      gutil.log(v);
    });
}

function logTasksSimple(env, localGulp) {
  console.log(Object.keys(localGulp.tasks)
    .join('\n')
    .trim());
}

// Format orchestrator errors
function formatError(e) {
  if (!e.err) {
    return e.message;
  }

  // PluginError
  if (typeof e.err.showStack === 'boolean') {
    return e.err.toString();
  }

  // Normal error
  if (e.err.stack) {
    return e.err.stack;
  }

  // Unknown (string, number, etc.)
  return new Error(String(e.err)).stack;
}

// Wire up logging events
function logEvents(pomyInst) {

  // Total hack due to poor error management in orchestrator
  pomyInst.on('err', function() {
    failed = true;
  });

  pomyInst.on('task_start', function(e) {
    // TODO: batch these
    // so when 5 tasks start at once it only logs one time with all 5
    gutil.log('Starting', '\'' + chalk.cyan(e.task) + '\'...');
  });

  pomyInst.on('task_stop', function(e) {
    var time = prettyTime(e.hrDuration);
    gutil.log(
      'Finished', '\'' + chalk.cyan(e.task) + '\'',
      'after', chalk.magenta(time)
    );
  });

  pomyInst.on('task_err', function(e) {
    var msg = formatError(e);
    var time = prettyTime(e.hrDuration);
    gutil.log(
      '\'' + chalk.cyan(e.task) + '\'',
      chalk.red('errored after'),
      chalk.magenta(time)
    );
    gutil.log(msg);
  });

  pomyInst.on('task_not_found', function(err) {
    gutil.log(
      chalk.red('Task \'' + err.task + '\' is not in your gulpfile')
    );
    gutil.log('Please check the documentation for proper gulpfile formatting');
    process.exit(1);
  });
}