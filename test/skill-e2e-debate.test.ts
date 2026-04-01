import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-debate');

afterAll(() => {
  finalizeEvalCollector(evalCollector);
});

// --- Debate E2E Tests ---

describeIfSelected('Debate skill — core', ['debate-core'], () => {
  let debateDir: string;

  beforeAll(() => {
    debateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-debate-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: debateDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Two competing approaches with tradeoff comments
    fs.writeFileSync(path.join(debateDir, 'polling.ts'), `
// Polling approach: simple HTTP requests on interval
// Pros: works everywhere, no persistent connections, easy to debug
// Cons: latency (up to interval), wasted requests when nothing changes
export function startPolling(url: string, intervalMs: number = 5000) {
  return setInterval(async () => {
    const res = await fetch(url);
    const data = await res.json();
    handleUpdate(data);
  }, intervalMs);
}

function handleUpdate(data: any) {
  console.log('Update received:', data);
}
`);

    fs.writeFileSync(path.join(debateDir, 'websocket.ts'), `
// WebSocket approach: persistent bidirectional connection
// Pros: real-time, low latency, server push
// Cons: connection management, reconnection logic, proxy issues
export function connectWebSocket(url: string) {
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleUpdate(data);
  };
  ws.onclose = () => {
    // Reconnect after delay
    setTimeout(() => connectWebSocket(url), 3000);
  };
  return ws;
}

function handleUpdate(data: any) {
  console.log('Update received:', data);
}
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial: polling vs websocket approaches']);
  });

  afterAll(() => {
    try { fs.rmSync(debateDir, { recursive: true, force: true }); } catch {}
  });

  test('/debate runs end-to-end with structured output', async () => {
    // Extract only the debate-specific steps (skip preamble, voice, completeness, etc.)
    const fullSkill = fs.readFileSync(path.join(ROOT, 'debate', 'SKILL.md'), 'utf-8');
    const debateStart = fullSkill.indexOf('# /debate - Multi-Model Structured Debate');
    const debateSection = fullSkill.slice(debateStart > 0 ? debateStart : 0);
    const skillExcerptPath = path.join(debateDir, 'debate-skill-excerpt.md');
    fs.writeFileSync(skillExcerptPath, debateSection);

    const result = await runSkillTest({
      prompt: `Read the file ${skillExcerptPath} for the /debate skill instructions.

Run /debate on this repo with the topic: "Should this service use polling or websockets for real-time updates?"

IMPORTANT:
- Do NOT use codex exec. Use Claude adversarial subagent for all opponent turns.
- Do NOT use AskUserQuestion. After synthesis, skip user judgment and save the transcript directly.
- Use --max-rounds 2 to keep the test fast.
- Make sure to output DEBATE_STATUS and DEBATE_RESULT machine-readable lines.
- Save the transcript to .context/`,
      workingDirectory: debateDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep', 'Agent'],
      timeout: 300_000,
      testName: 'debate-core',
      runId,
    });

    logCost('/debate core', result);
    expect(result.exitReason).toBe('success');

    const output = result.output;

    // Structured headers appeared
    expect(output.includes('POSITION:')).toBe(true);

    // At least one round ran
    expect(output.includes('Round 1')).toBe(true);

    // Machine-readable result line present
    expect(output.includes('DEBATE_RESULT:')).toBe(true);

    // Transcript saved — assert unconditionally so broken saves fail the test
    const contextDir = path.join(debateDir, '.context');
    expect(fs.existsSync(contextDir)).toBe(true);
    const transcripts = fs.readdirSync(contextDir).filter(f => f.startsWith('debate-transcript-'));
    expect(transcripts.length).toBeGreaterThanOrEqual(1);

    recordE2E(evalCollector, 'debate-core', 'e2e-debate', result);
  }, 300_000);
});

describeIfSelected('Debate skill — convergence', ['debate-convergence'], () => {
  let debateDir: string;

  beforeAll(() => {
    debateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-debate-conv-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: debateDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    // Heavily favor websockets: full infrastructure already exists
    fs.writeFileSync(path.join(debateDir, 'websocket-server.ts'), `
// Full websocket infrastructure already in place
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

export function broadcast(data: any) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    client.send(msg);
  }
}

export function getClientCount(): number {
  return clients.size;
}
`);

    fs.writeFileSync(path.join(debateDir, 'websocket-client.ts'), `
// Client-side websocket with reconnection, heartbeat, error handling
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private reconnectMs = 1000;
  private maxReconnectMs = 30000;

  constructor(private url: string) {}

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => { this.reconnectMs = 1000; };
    this.ws.onclose = () => {
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    };
    this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));
  }

  private handleMessage(data: any) { /* process update */ }
  disconnect() { this.ws?.close(); }
}
`);

    // Polling stub is empty — no infrastructure
    fs.writeFileSync(path.join(debateDir, 'polling.ts'), `
// Placeholder: polling approach not implemented
// No infrastructure exists for this approach
export function poll() {
  throw new Error('Not implemented');
}
`);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial: websocket infra complete, polling not implemented']);
  });

  afterAll(() => {
    try { fs.rmSync(debateDir, { recursive: true, force: true }); } catch {}
  });

  test('/debate detects convergence when one side is clearly stronger', async () => {
    // Extract only the debate-specific steps (skip preamble, voice, completeness, etc.)
    const fullSkill = fs.readFileSync(path.join(ROOT, 'debate', 'SKILL.md'), 'utf-8');
    const debateStart = fullSkill.indexOf('# /debate - Multi-Model Structured Debate');
    const debateSection = fullSkill.slice(debateStart > 0 ? debateStart : 0);
    const skillExcerptPath = path.join(debateDir, 'debate-skill-excerpt.md');
    fs.writeFileSync(skillExcerptPath, debateSection);

    const result = await runSkillTest({
      prompt: `Read the file ${skillExcerptPath} for the /debate skill instructions.

Run /debate on this repo with the topic: "Should this service use polling or websockets?"

The codebase already has full websocket infrastructure (server + client with reconnection).
Polling has no implementation at all. The evidence strongly favors websockets.

IMPORTANT:
- Do NOT use codex exec. Use Claude adversarial subagent for all opponent turns.
- Do NOT use AskUserQuestion. After synthesis, skip user judgment and save the transcript directly.
- Use --max-rounds 3.
- Make sure to output DEBATE_STATUS and DEBATE_RESULT machine-readable lines.
- Save the transcript to .context/`,
      workingDirectory: debateDir,
      maxTurns: 25,
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep', 'Agent'],
      timeout: 300_000,
      testName: 'debate-convergence',
      runId,
    });

    logCost('/debate convergence', result);
    expect(result.exitReason).toBe('success');

    const output = result.output;

    // Machine-readable result present
    expect(output.includes('DEBATE_RESULT:')).toBe(true);

    // With overwhelming evidence for one side, the debate should converge or concede
    const resultLine = output.split('\n').find(l => l.includes('DEBATE_RESULT:'));
    expect(resultLine).toBeDefined();
    const converged = resultLine!.includes('outcome=converged') || resultLine!.includes('outcome=conceded');
    expect(converged).toBe(true);
    // Verify it converged quickly (within the 3-round cap)
    const roundMatch = resultLine!.match(/rounds=(\d+)/);
    if (roundMatch) {
      expect(parseInt(roundMatch[1])).toBeLessThanOrEqual(3);
    }

    // Transcript saved — assert unconditionally so broken saves fail the test
    const contextDir = path.join(debateDir, '.context');
    expect(fs.existsSync(contextDir)).toBe(true);
    const transcripts = fs.readdirSync(contextDir).filter(f => f.startsWith('debate-transcript-'));
    expect(transcripts.length).toBeGreaterThanOrEqual(1);

    recordE2E(evalCollector, 'debate-convergence', 'e2e-debate', result);
  }, 300_000);
});
