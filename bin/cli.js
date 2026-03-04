#!/usr/bin/env node
'use strict';

const pkg = require('../package.json');

const COMMANDS = {
  run:      { desc: '自动编码循环',             usage: 'claude-coder run [需求] [--max N] [--pause N] [--dry-run]' },
  setup:    { desc: '交互式模型配置',           usage: 'claude-coder setup' },
  init:     { desc: '初始化项目环境',           usage: 'claude-coder init' },
  view:     { desc: '观测模式（交互式单次）',   usage: 'claude-coder view [需求]' },
  add:      { desc: '追加任务到 tasks.json',    usage: 'claude-coder add "指令"' },
  validate: { desc: '手动校验上次 session',     usage: 'claude-coder validate' },
  status:   { desc: '查看任务进度和成本',       usage: 'claude-coder status' },
  config:   { desc: '配置管理',                 usage: 'claude-coder config sync' },
};

function showHelp() {
  console.log(`\nClaude Coder v${pkg.version}\n`);
  console.log('用法: claude-coder <command> [options]\n');
  console.log('命令:');
  for (const [name, info] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${info.desc}`);
  }
  console.log('\n示例:');
  console.log('  claude-coder setup                   配置模型和 API Key');
  console.log('  claude-coder run "实现用户登录"       开始自动编码');
  console.log('  claude-coder run --max 5 --dry-run   预览模式');
  console.log('  claude-coder status                  查看进度和成本');
  console.log(`\n前置条件: npm install -g @anthropic-ai/claude-agent-sdk`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const opts = { max: 50, pause: 5, dryRun: false };
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--max':
        opts.max = parseInt(args[++i], 10) || 50;
        break;
      case '--pause':
        opts.pause = parseInt(args[++i], 10) || 5;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--view':
        opts.viewMode = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      default:
        if (!args[i].startsWith('--')) {
          positional.push(args[i]);
        }
        break;
    }
  }

  return { command, positional, opts };
}

async function main() {
  const { command, positional, opts } = parseArgs(process.argv);

  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    console.log(pkg.version);
    process.exit(0);
  }

  switch (command) {
    case 'run': {
      const runner = require('../src/runner');
      if (opts.viewMode) {
        await runner.view(positional[0] || null, opts);
      } else {
        await runner.run(positional[0] || null, opts);
      }
      break;
    }
    case 'setup': {
      const setup = require('../src/setup');
      await setup.setup();
      break;
    }
    case 'init': {
      const { init } = require('../src/init');
      await init();
      break;
    }
    case 'view': {
      const runner = require('../src/runner');
      await runner.view(positional[0] || null, opts);
      break;
    }
    case 'add': {
      if (!positional[0]) {
        console.error('用法: claude-coder add "任务描述"');
        process.exit(1);
      }
      const runner = require('../src/runner');
      await runner.add(positional[0], opts);
      break;
    }
    case 'validate': {
      const validator = require('../src/validator');
      const result = await validator.validate();
      process.exit(result.fatal ? 1 : 0);
      break;
    }
    case 'status': {
      const tasks = require('../src/tasks');
      tasks.showStatus();
      break;
    }
    case 'config': {
      const config = require('../src/config');
      if (positional[0] === 'sync') {
        config.syncToGlobal();
      } else {
        console.error('用法: claude-coder config sync');
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`未知命令: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n错误: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
