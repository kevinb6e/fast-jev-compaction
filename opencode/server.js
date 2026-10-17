// src/request.ts
var SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
var OPENROUTER_SYSTEM_ONE_URL = "https://openrouter.ai/api/v1/systemone";
var OPENCODE_SYSTEM_ONE_URL = "https://opencode.ai/inference/systemone/v1/systemone";
var DEFAULT_MODEL = "jev-latest";
var OPENCODE_DEFAULT_MODEL = "jev-1.13";
var OPENCODE_ZEN_URL = "https://opencode.ai/zen/v1/systemone";
var OPENCODE_ZEN_FREE_MODEL = "jev-1.13-free";
var PROVIDER_OVERRIDE_ENV_KEY = "FAST_JEV_PROVIDER";
var PROVIDERS = {
  typesafe: { url: SYSTEM_ONE_URL, envKey: "TYPESAFE_API_KEY", model: DEFAULT_MODEL },
  openrouter: { url: OPENROUTER_SYSTEM_ONE_URL, envKey: "OPENROUTER_API_KEY", model: DEFAULT_MODEL },
  opencode: { url: OPENCODE_SYSTEM_ONE_URL, envKey: "OPENCODE_API_KEY", model: OPENCODE_DEFAULT_MODEL },
  zen: { url: OPENCODE_ZEN_URL, envKey: "OPENCODE_API_KEY", model: OPENCODE_ZEN_FREE_MODEL }
};
function providerView(key) {
  const view = {};
  for (const name of Object.keys(PROVIDERS)) {
    view[name] = PROVIDERS[name][key];
  }
  return view;
}
var PROVIDER_URLS = providerView("url");
var PROVIDER_ENV_KEYS = providerView("envKey");
var OPENROUTER_KEY_PREFIX = "sk-or-";
function isJevProvider(value) {
  return value === "typesafe" || value === "openrouter" || value === "opencode" || value === "zen";
}
function defaultModelFor(provider) {
  return PROVIDERS[provider].model;
}
function missingApiKeyError(provider) {
  return new Error(`${PROVIDERS[provider].envKey} is not configured`);
}
function resolveJevProvider(options = {}, env = {}) {
  if (options.provider) return options.provider;
  const override = env[PROVIDER_OVERRIDE_ENV_KEY];
  if (isJevProvider(override)) return override;
  if (options.baseUrl) {
    if (/openrouter\.ai/i.test(options.baseUrl)) return "openrouter";
    if (/opencode\.ai\/zen/i.test(options.baseUrl)) return "zen";
    if (/opencode\.ai/i.test(options.baseUrl)) return "opencode";
    return "typesafe";
  }
  const typesafe = env[PROVIDERS.typesafe.envKey];
  const openrouter = env[PROVIDERS.openrouter.envKey];
  if (typesafe?.startsWith(OPENROUTER_KEY_PREFIX) || openrouter?.startsWith(OPENROUTER_KEY_PREFIX)) {
    return "openrouter";
  }
  if (openrouter && !typesafe) return "openrouter";
  if (env[PROVIDERS.opencode.envKey] && !typesafe && !openrouter) return "opencode";
  return "typesafe";
}
function buildJevRequest(params, state, questions) {
  return {
    url: params.baseUrl ?? PROVIDERS[params.provider ?? "typesafe"].url,
    method: "POST",
    headers: {
      ...params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {},
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: params.model ?? defaultModelFor(params.provider ?? "typesafe"),
      state,
      questions
    })
  };
}
function parseJevResponse(status, ok, text) {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("answers" in parsed) || parsed.answers === null || typeof parsed.answers !== "object") {
    throw new Error("Jev response is missing answers");
  }
  return parsed;
}
function noulAnswer(answers, name) {
  const answer = answers[name];
  if (!answer || !("noul" in answer) || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

// src/state.ts
var STATE_CONTEXT = "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";
var STATE_CONTEXT_TEXT = " Other questions ask the same about a block of text the harness injected (a skill body, command output, a report or reminder, shown as an `[xN: \u2026]` note) or the full wording of a long assistant reply (marked `text_block`); a skill can be reloaded and a command re-run.";
var INPUT_CHARS = [1e3, 200, 60];
var TEXT_HEAD = 400;
var TEXT_TAIL = 150;
var ALNUM_RUN = /[A-Za-z0-9]+/g;
function estimateTokens(text) {
  let tokens = 0;
  let last = 0;
  for (const match of text.matchAll(ALNUM_RUN)) {
    const run = match[0];
    const plain = runTokens(run);
    tokens += separatorTokens(text.slice(last, match.index)) + (isDenseRun(run) ? Math.max(plain, run.length / 3) : plain);
    last = match.index + run.length;
  }
  return Math.ceil(tokens + separatorTokens(text.slice(last)));
}
function runTokens(run) {
  let tokens = 0;
  for (const [piece] of run.matchAll(/[A-Za-z]+|\d+/g)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else tokens += 1 + Math.floor((piece.length - 1) / 6);
  }
  return tokens;
}
function separatorTokens(chunk) {
  return chunk.replace(/\s+/g, "").length * 0.9;
}
function isDenseRun(run) {
  if (run.length < 8) return false;
  const hasDigit = /\d/.test(run);
  const hasLetter = /[A-Za-z]/.test(run);
  if (hasDigit) return hasLetter;
  if (!hasLetter || run.length < 16) return false;
  const vowels = run.match(/[aeiouAEIOU]/g)?.length ?? 0;
  return vowels / run.length < 0.25 && new Set(run).size >= 8;
}
function splitsSurrogatePair(text, index) {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 55296 && before <= 56319 && after >= 56320 && after <= 57343;
}
function safeCutEnd(text, end) {
  return splitsSurrogatePair(text, end) ? end - 1 : end;
}
function safeCutStart(text, start) {
  return splitsSurrogatePair(text, start) ? start - 1 : start;
}
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, safeCutEnd(text, Math.max(0, limit - 1)))}\u2026`;
}
function abridge(text, head, tail) {
  if (text.length <= head + tail + 40) return text;
  const end = safeCutEnd(text, head);
  const start = safeCutStart(text, Math.max(0, text.length - tail));
  return `${text.slice(0, end)}
[\u2026 ${start - end} chars omitted \u2026]
${text.slice(start)}`;
}
function isPinned(index, total, preserveRecentMessages) {
  return index === 0 || index >= total - preserveRecentMessages;
}
function collectToolCalls(messages, preserveRecentMessages) {
  const results = /* @__PURE__ */ new Map();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned: isPinned(callIndex, messages.length, preserveRecentMessages) || isPinned(found.index, messages.length, preserveRecentMessages)
      });
    }
  });
  return calls;
}
function inputText(input, limit) {
  let json = "";
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}
function resultNote(call) {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}
function compactCall(call) {
  const input = Object.entries(call.input).map(([key, value]) => {
    const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
    return `${key}=${text.replace(/\s+/g, " ")}`;
  }).join(" ");
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} \u2192 ${call.isError ? "error" : "ok"} ${call.resultChars}ch`;
}
function mergeCallRuns(history, pinned) {
  const merged = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (e) => !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === "string";
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...previous.tool_calls, ...entry.tool_calls];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}
function callsByMessage(calls) {
  const byMessage = /* @__PURE__ */ new Map();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}
function stateText(message, blocks) {
  let text = message.text;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    if (block.kind === "reply") continue;
    text = `${text.slice(0, block.start)}[${block.id}: ${block.label}, ${block.chars} chars]${text.slice(block.end)}`;
  }
  return text;
}
function blocksByMessage(blocks) {
  const byMessage = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    const list = byMessage.get(block.index) ?? [];
    list.push(block);
    byMessage.set(block.index, list);
  }
  return byMessage;
}
function historyEntries(messages, calls, inputChars, blocks = []) {
  const byMessage = callsByMessage(calls);
  const textBlocks = blocksByMessage(blocks);
  const entries = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call)
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const own = textBlocks.get(i) ?? [];
    const entry = { i, role: message.role, text: stateText(message, own) };
    const reply = own.find((block) => block.kind === "reply" && !block.pinned);
    if (reply) entry.text_block = reply.id;
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}
var GOAL_CHARS = 500;
function goalFromMessages(messages, blocks = []) {
  const textBlocks = blocksByMessage(blocks);
  return messages.map((message, index) => ({ message, text: stateText(message, textBlocks.get(index) ?? []) })).filter(
    ({ message, text }) => message.role === "user" && text.trim().length > 0 && (message.toolResults ?? []).length === 0
  ).slice(-3).map(({ text }) => truncate(text, GOAL_CHARS)).join("\n");
}
function goalWith(goal, instructions) {
  const extra = truncate(instructions.trim(), GOAL_CHARS);
  if (extra.length === 0) return goal;
  return goal.length > 0 ? `${goal}

${extra}` : extra;
}
function fitState(messages, calls, options, blocks = []) {
  const goal = goalWith(options.goal || goalFromMessages(messages, blocks), options.instructions);
  const context = blocks.length > 0 ? STATE_CONTEXT + STATE_CONTEXT_TEXT : STATE_CONTEXT;
  const stateOf = (history2) => ({
    context,
    goal,
    history: history2
  });
  const entryTokens = (entry) => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history2, tokens2, stage) => ({
    state: stateOf(history2),
    tokens: tokens2,
    stage
  });
  let history = [];
  let perEntry = [];
  let tokens = 0;
  const rebuild = (inputChars) => {
    history = historyEntries(messages, calls, inputChars, blocks);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = () => tokens <= options.maxStateTokens;
  const shrink = (index, change) => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };
  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, "full");
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }
  const pinned = (entry) => isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index])),
    ...indices.filter((index) => pinned(history[index]))
  ];
  for (const index of order) {
    const entry = history[index];
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }
  for (const index of order) {
    const entry = history[index];
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[\u2026 ${original} chars omitted \u2026]`;
    });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }
  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index];
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }
  const left = /* @__PURE__ */ new Set();
  for (const index of order) {
    const entry = history[index];
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        "old messages left out"
      );
    }
  }
  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, "old calls merged");
  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`
  );
}

// src/text.ts
var DUPLICATE_MIN_CHARS = 200;
var REPLY_HEAD = 600;
var REPLY_TAIL = 300;
var INJECTED = [
  { kind: "skill", regex: /Base directory for this skill:[^\n]*\n[\s\S]*?(?=\nARGUMENTS:|$)/g },
  { kind: "context_report", regex: /## Context Usage\n[\s\S]*?(?=\n<local-command-caveat>|\n<command-name>|$)/g },
  { kind: "command_output", regex: /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g },
  { kind: "system_reminder", regex: /<system-reminder>[\s\S]*?<\/system-reminder>/g }
];
function labelOf(kind, content) {
  if (kind === "skill") {
    const dir = /Base directory for this skill:\s*(\S+)/.exec(content)?.[1] ?? "";
    const name2 = dir.replace(/\/+$/, "").split("/").filter(Boolean);
    const skill = name2[name2.length - 1] ?? "unknown";
    return `skill ${skill === "SKILL.md" ? name2[name2.length - 2] ?? skill : skill}`;
  }
  if (kind === "context_report") return "/context report";
  if (kind === "reply") return "assistant reply";
  const inner = content.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
  const firstLine = inner.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  const name = kind === "command_output" ? "command output" : "system reminder";
  return firstLine ? `${name} "${truncate(firstLine, 60)}"` : name;
}
function injectedRanges(text) {
  const found = [];
  for (const { kind, regex } of INJECTED) {
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      found.push({ kind, start, end: start + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges = [];
  for (const range of found) {
    const last = ranges[ranges.length - 1];
    if (last && range.start < last.end) continue;
    ranges.push(range);
  }
  return ranges;
}
function collectTextBlocks(messages, options) {
  const blocks = [];
  const add = (block) => {
    blocks.push({ ...block, id: `x${blocks.length + 1}`, duplicate: false });
  };
  messages.forEach((message, index) => {
    const pinned = isPinned(index, messages.length, options.preserveRecentMessages);
    if (message.role === "user" && options.injectedMinChars > 0) {
      for (const range of injectedRanges(message.text)) {
        const content = message.text.slice(range.start, range.end);
        if (content.length < DUPLICATE_MIN_CHARS) continue;
        add({
          index,
          kind: range.kind,
          start: range.start,
          end: range.end,
          chars: content.length,
          label: labelOf(range.kind, content),
          pinned
        });
      }
    }
    if (message.role === "assistant" && options.replyMinChars > 0 && message.text.length >= Math.max(options.replyMinChars, REPLY_HEAD + REPLY_TAIL + 200)) {
      add({
        index,
        kind: "reply",
        start: 0,
        end: message.text.length,
        chars: message.text.length,
        label: "assistant reply",
        pinned
      });
    }
  });
  const seen = /* @__PURE__ */ new Set();
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === "reply") continue;
    const content = messages[block.index].text.slice(block.start, block.end);
    if (seen.has(content)) block.duplicate = true;
    else seen.add(content);
  }
  return blocks;
}
function textCandidates(blocks, options) {
  return blocks.filter(
    (block) => !block.pinned && !block.duplicate && (block.kind === "reply" || block.chars >= options.injectedMinChars)
  );
}
function textQuestionsFor(block) {
  const instructions = block.kind === "reply" ? `The full text of assistant reply ${block.id} (message ${block.index}, ${block.chars} chars) should stay in the history verbatim: the assistant still needs its exact wording; otherwise only its opening and closing are kept` : `Block ${block.id} in message ${block.index} (${block.label}, ${block.chars} chars) should stay in the history verbatim: the assistant still needs its exact contents for what it does next; otherwise only a one-line note remains`;
  return { [`text_${block.id}`]: { type: "noul", instructions } };
}
function decideText(block, answer, options) {
  const base = { id: block.id, kind: block.kind, label: block.label, keep: answer?.keep ?? 1 };
  if (block.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (block.duplicate) return { ...base, keep: 0, action: "remove", reason: "duplicate" };
  if (!answer) return { ...base, action: "keep", reason: "small" };
  if (answer.keep >= options.keepThreshold) return { ...base, action: "keep", reason: "kept" };
  return block.kind === "reply" ? { ...base, action: "abridge", reason: "abridged" } : { ...base, action: "remove", reason: "removed" };
}
function replacement(block, decision, text) {
  if (decision.action === "abridge") {
    const end = safeCutEnd(text, REPLY_HEAD);
    const start = safeCutStart(text, Math.max(0, text.length - REPLY_TAIL));
    return `${text.slice(0, end)}
[fast-jev-compaction abridged ${start - end} chars of this reply]
${text.slice(start)}`;
  }
  const why = decision.reason === "duplicate" ? "repeated later" : `${block.chars} chars`;
  return `[fast-jev-compaction removed ${block.label}: ${why}]`;
}
function applyTextDecisions(messages, blocks, decisions) {
  const actions = new Map(decisions.map((decision) => [decision.id, decision]));
  const byMessage = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (actions.get(block.id)?.action === "keep") continue;
    const list = byMessage.get(block.index) ?? [];
    list.push(block);
    byMessage.set(block.index, list);
  }
  return messages.map((message, index) => {
    const touched = byMessage.get(index);
    if (!touched) return message;
    let text = message.text;
    for (const block of [...touched].sort((a, b) => b.start - a.start)) {
      const decision = actions.get(block.id);
      const original = text.slice(block.start, block.end);
      text = text.slice(0, block.start) + replacement(block, decision, original) + text.slice(block.end);
    }
    const rebuilt = { role: message.role, text, toolUses: message.toolUses };
    if (message.toolResults) rebuilt.toolResults = message.toolResults;
    return rebuilt;
  });
}

// src/compact.ts
var DEFAULT_OPTIONS = {
  goal: "",
  instructions: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25e3,
  maxRequestTokens: 3e4,
  truncateHeadChars: 300,
  injectedMinChars: 1e3,
  replyMinChars: 2e3
};
var REQUEST_OVERHEAD_TOKENS = 20;
var MAX_QUESTIONS = 128;
function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function resolveOptions(options = {}) {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    instructions: options.instructions ?? DEFAULT_OPTIONS.instructions,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)
      )
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars))
    ),
    injectedMinChars: Math.max(
      0,
      Math.floor(finite(options.injectedMinChars, DEFAULT_OPTIONS.injectedMinChars))
    ),
    replyMinChars: Math.max(
      0,
      Math.floor(finite(options.replyMinChars, DEFAULT_OPTIONS.replyMinChars))
    )
  };
}
function questionsFor(call) {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`
    }
  };
}
function batchItems(items, questionsOf, stateTokens, options) {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches = [];
  let current = [];
  let currentTokens = 0;
  let currentQuestions = 0;
  for (const item of items) {
    const questions = questionsOf(item);
    const tokens = estimateTokens(JSON.stringify(questions));
    const asked = Object.keys(questions).length;
    if (current.length > 0 && (currentTokens + tokens > budget || currentQuestions + asked > MAX_QUESTIONS)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
      currentQuestions = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`
      );
    }
    current.push(item);
    currentTokens += tokens;
    currentQuestions += asked;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
function decideCall(call, answer, options) {
  const base = { id: call.id, tool_use_id: call.tool_use_id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: "keep", reason: "kept" };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: "drop_result", reason: "result_dropped" };
  }
  return { ...base, action: "drop_call", reason: "call_dropped" };
}
function itemQuestions(item) {
  return "call" in item ? questionsFor(item.call) : textQuestionsFor(item.block);
}
async function askBatch(asker, state, batch) {
  const questions = Object.assign({}, ...batch.map(itemQuestions));
  const { answers } = await asker.ask(state, questions);
  const calls = /* @__PURE__ */ new Map();
  const texts = /* @__PURE__ */ new Map();
  for (const item of batch) {
    if ("call" in item) {
      calls.set(item.call.id, {
        keepCall: noulAnswer(answers, `call_${item.call.id}`),
        keepResult: noulAnswer(answers, `result_${item.call.id}`)
      });
    } else {
      texts.set(item.block.id, { keep: noulAnswer(answers, `text_${item.block.id}`) });
    }
  }
  return { calls, texts };
}
function truncatedResultText(text, isError, headChars) {
  if (text.length <= headChars + 120) return text;
  const end = headChars > 0 ? safeCutEnd(text, headChars) : 0;
  const head = end > 0 ? `${text.slice(0, end)}
` : "";
  return `${head}[fast-jev-compaction truncated ${text.length - end} chars of this tool result${isError ? " (error)" : ""}; re-run the tool if needed]`;
}
function applyDecisions(messages, decisions, calls, headChars) {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = /* @__PURE__ */ new Map();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== "keep") actions.set(call.tool_use_id, decision.action);
  }
  return applyActions(messages, actions, headChars);
}
function applyActions(messages, actions, headChars) {
  const kept = [];
  for (const message of messages) {
    const touched = message.toolUses.some((tool) => actions.has(tool.tool_use_id)) || (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses.filter((tool) => actions.get(tool.tool_use_id) !== "drop_call").map((tool) => {
      if (actions.get(tool.tool_use_id) !== "drop_result") return tool;
      const text = truncatedResultText(
        tool.text ?? "",
        tool.isError ?? false,
        headChars
      );
      if ((tool.text ?? "") === text) return tool;
      const copy = {
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        text
      };
      if (tool.isError) copy.isError = true;
      return copy;
    });
    const toolResults = (message.toolResults ?? []).filter((result) => actions.get(result.tool_use_id) !== "drop_call").map((result) => {
      if (actions.get(result.tool_use_id) !== "drop_result") return result;
      const text = truncatedResultText(result.text, result.isError ?? false, headChars);
      return text === result.text ? result : {
        tool_use_id: result.tool_use_id,
        text,
        isError: result.isError
      };
    });
    if (!message.toolUses.some(
      (tool) => actions.get(tool.tool_use_id) === "drop_call"
    ) && !(message.toolResults ?? []).some(
      (result) => actions.get(result.tool_use_id) === "drop_call"
    ) && toolUses.every((tool, index) => tool === message.toolUses[index]) && toolResults.every(
      (result, index) => result === message.toolResults?.[index]
    )) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}
function messageChars(message) {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}
function count(decisions, reason) {
  return decisions.filter((decision) => decision.reason === reason).length;
}
async function compact(messages, asker, options = {}) {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const blocks = collectTextBlocks(messages, resolved);
  const textAsked = textCandidates(blocks, resolved);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  let fitted = { tokens: 0, stage: "" };
  let batches = [];
  const answers = /* @__PURE__ */ new Map();
  const textAnswers = /* @__PURE__ */ new Map();
  const items = [
    ...candidates.map((call) => ({ call })),
    ...textAsked.map((block) => ({ block }))
  ];
  if (items.length > 0) {
    const state = fitState(messages, calls, resolved, blocks);
    fitted = state;
    batches = batchItems(items, itemQuestions, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch))
    );
    for (const part of answered) {
      for (const [id, answer] of part.calls) answers.set(id, answer);
      for (const [id, answer] of part.texts) textAnswers.set(id, answer);
    }
  }
  const decisions = calls.map(
    (call) => decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved)
  );
  const textDecisions = blocks.map(
    (block) => decideText(block, textAnswers.get(block.id), resolved)
  );
  const kept = applyDecisions(
    applyTextDecisions(messages, blocks, textDecisions),
    decisions,
    calls,
    resolved.truncateHeadChars
  );
  return {
    messages: kept,
    decisions,
    textDecisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, "kept"),
      resultsDropped: count(decisions, "result_dropped"),
      callsDropped: count(decisions, "call_dropped"),
      pinned: count(decisions, "pinned"),
      texts: blocks.length,
      textsRemoved: count(textDecisions, "removed"),
      duplicatesRemoved: count(textDecisions, "duplicate"),
      repliesAbridged: count(textDecisions, "abridged"),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started
    }
  };
}

// src/client.ts
var JevClient = class {
  apiKey;
  model;
  baseUrl;
  provider;
  fetcher;
  constructor(options = {}) {
    const env = options.env ?? process.env;
    this.provider = resolveJevProvider(
      { provider: options.provider, baseUrl: options.baseUrl },
      options.apiKey === void 0 ? env : void 0
    );
    this.apiKey = options.apiKey ?? env[PROVIDERS[this.provider].envKey] ?? "";
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }
  /** The provider this client resolves to, for logs and error messages. */
  get resolvedProvider() {
    return this.provider;
  }
  async ask(state, questions) {
    if (!this.apiKey && this.provider !== "zen" && !this.baseUrl) {
      throw missingApiKeyError(this.provider);
    }
    const request = buildJevRequest(
      {
        apiKey: this.apiKey,
        model: this.model,
        provider: this.provider,
        baseUrl: this.baseUrl
      },
      state,
      questions
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
};

// src/opencode/pruner.ts
var PRUNER_DEFAULTS = {
  compactAtPercent: 60,
  contextTokens: 2e5,
  checkpointTokens: 4e4,
  cooldownMs: 6e4
};
var NUMBER_KEYS = [
  "keepThreshold",
  "preserveRecentMessages",
  "maxStateTokens",
  "maxRequestTokens",
  "truncateHeadChars",
  "compactAtPercent",
  "contextTokens",
  "checkpointTokens",
  "cooldownMs"
];
function readPrunerOptions(options = {}, env = process.env) {
  const numbers = {};
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value)) numbers[key] = value;
  }
  const string = (key) => {
    const value = options[key];
    return typeof value === "string" && value.length > 0 ? value : void 0;
  };
  let model = string("model") ?? (env["FAST_JEV_MODEL"] || void 0);
  let explicitProvider = options["provider"] ?? (env["FAST_JEV_PROVIDER"] || void 0);
  if (model?.startsWith("opencode/")) {
    model = model.slice("opencode/".length);
    explicitProvider ??= "zen";
  }
  const typesafeKey = string("apiKey") ?? (env["TYPESAFE_API_KEY"] || void 0);
  const openrouterKey = env[PROVIDERS.openrouter.envKey];
  const provider = explicitProvider === "typesafe" || explicitProvider === "openrouter" || explicitProvider === "opencode" || explicitProvider === "zen" ? explicitProvider : typesafeKey ? "typesafe" : openrouterKey ? "openrouter" : "zen";
  const resolved = {
    ...resolveOptions({
      goal: string("goal"),
      keepThreshold: numbers.keepThreshold,
      preserveRecentMessages: numbers.preserveRecentMessages,
      maxStateTokens: numbers.maxStateTokens,
      maxRequestTokens: numbers.maxRequestTokens,
      truncateHeadChars: numbers.truncateHeadChars
    }),
    provider,
    model: model ?? PROVIDERS[provider].model,
    compactAtPercent: numbers.compactAtPercent ?? PRUNER_DEFAULTS.compactAtPercent,
    contextTokens: numbers.contextTokens ?? PRUNER_DEFAULTS.contextTokens,
    checkpointTokens: numbers.checkpointTokens ?? PRUNER_DEFAULTS.checkpointTokens,
    cooldownMs: Math.max(0, numbers.cooldownMs ?? PRUNER_DEFAULTS.cooldownMs)
  };
  const apiKey = string("apiKey") ?? (provider === "openrouter" ? openrouterKey : provider === "typesafe" ? typesafeKey : env[PROVIDERS[provider].envKey] || void 0);
  if (apiKey) resolved.apiKey = apiKey;
  const baseUrl = string("baseUrl") ?? (provider === "zen" ? OPENCODE_ZEN_URL : provider === "opencode" ? PROVIDERS.opencode.url : void 0);
  if (baseUrl) resolved.baseUrl = baseUrl;
  return resolved;
}
function missingKey(options) {
  return options.provider !== "zen" && !options.apiKey && !options.baseUrl;
}
function describeProvider(options) {
  const where = options.baseUrl ?? "TypeSafe";
  const auth = options.apiKey ? "with key" : "no key";
  return `${options.model} at ${where} (${auth})`;
}
function jevClient(options, fetchFn) {
  return new JevClient({
    apiKey: options.apiKey,
    model: options.model,
    baseUrl: options.baseUrl,
    provider: options.provider,
    fetch: fetchFn
  });
}
function stringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function transcriptTokens(messages) {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.text);
    for (const tool of message.toolUses) total += estimateTokens(stringify(tool.input));
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  }
  return total;
}
function renderTranscript(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (message.text.trim()) lines.push(`[User]: ${message.text}`);
      continue;
    }
    if (message.text.trim()) lines.push(`[Assistant]: ${message.text}`);
    for (const tool of message.toolUses) {
      lines.push(`[Assistant tool call]: ${tool.tool}(${stringify(tool.input)})`);
      if (tool.text !== void 0) {
        lines.push(`[Tool ${tool.isError ? "error" : "result"}]: ${tool.text}`);
      }
    }
  }
  return lines.join("\n\n");
}
var SessionPruner = class {
  constructor(asker, options, now = Date.now) {
    this.asker = asker;
    this.options = options;
    this.now = now;
  }
  asker;
  options;
  now;
  sessions = /* @__PURE__ */ new Map();
  /** When the last Jev failure happened; requests pause for `cooldownMs` after it. */
  failedAt;
  /** True while a recent Jev failure keeps requests paused. */
  coolingDown() {
    return this.failedAt !== void 0 && this.now() - this.failedAt < this.options.cooldownMs;
  }
  /** The actions decided so far for a session. */
  actions(session) {
    return this.sessions.get(session)?.actions ?? /* @__PURE__ */ new Map();
  }
  forget(session) {
    this.sessions.delete(session);
  }
  state(session) {
    let state = this.sessions.get(session);
    if (!state) {
      state = { actions: /* @__PURE__ */ new Map(), asked: /* @__PURE__ */ new Set() };
      this.sessions.set(session, state);
    }
    return state;
  }
  async prune(session, messages, input = {}) {
    const state = this.state(session);
    const headChars = this.options.truncateHeadChars;
    const applied = applyActions(messages, state.actions, headChars);
    const tokensBefore = transcriptTokens(applied);
    const contextTokens = input.contextTokens ?? this.options.contextTokens;
    const threshold = Math.floor(contextTokens * this.options.compactAtPercent / 100);
    const base = { actions: state.actions, threshold, tokensBefore, tokensAfter: tokensBefore };
    if (!input.force && tokensBefore < threshold) return { ...base, reason: "under_threshold" };
    const preserveRecentMessages = input.preserveRecentMessages ?? this.options.preserveRecentMessages;
    const candidates = collectToolCalls(applied, preserveRecentMessages).filter((call) => !call.pinned);
    if (candidates.length === 0) return { ...base, reason: "no_candidates" };
    if (!input.force && candidates.every((call) => state.asked.has(call.tool_use_id))) {
      return { ...base, reason: "no_new_calls" };
    }
    if (!input.force && this.coolingDown()) return { ...base, reason: "cooldown" };
    let result;
    try {
      result = await compact(applied, this.asker, {
        ...this.options,
        preserveRecentMessages,
        injectedMinChars: 0,
        replyMinChars: 0
      });
    } catch (error) {
      this.failedAt = this.now();
      throw error;
    }
    this.failedAt = void 0;
    for (const call of candidates) state.asked.add(call.tool_use_id);
    for (const decision of result.decisions) {
      if (decision.action === "keep") continue;
      const current = state.actions.get(decision.tool_use_id);
      if (decision.action === "drop_call" || current === void 0) {
        state.actions.set(decision.tool_use_id, decision.action);
      }
    }
    const tokensAfter = transcriptTokens(applyActions(messages, state.actions, headChars));
    return { ...base, reason: "pruned", result, tokensAfter };
  }
};
function describeOutcome(outcome) {
  const stats = outcome.result?.stats;
  const decisions = stats ? [
    stats.kept > 0 ? `${stats.kept} kept` : "",
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
    stats.pinned > 0 ? `${stats.pinned} pinned` : ""
  ].filter(Boolean).join(", ") || "no tool calls" : outcome.reason;
  const requests = stats ? ` in ${stats.requests} request(s)` : "";
  return `${decisions}; ~${outcome.tokensBefore} \u2192 ~${outcome.tokensAfter} tokens (threshold ${outcome.threshold})${requests}`;
}

// src/opencode/v1.ts
var CLEARED_OUTPUT = "[Old tool result content cleared]";
function toolOutcome(part) {
  if (part.state.status === "completed") {
    return { text: part.state.time.compacted ? CLEARED_OUTPUT : part.state.output, isError: false };
  }
  if (part.state.status === "error") return { text: part.state.error, isError: true };
  return void 0;
}
function userText(parts) {
  const lines = [];
  for (const part of parts) {
    if (part.type === "text" && !part.ignored && part.text) lines.push(part.text);
    else if (part.type === "file") lines.push(`[Attached ${part.mime}: ${part.filename ?? "file"}]`);
    else if (part.type === "compaction") lines.push("[Conversation compacted]");
  }
  return lines.join("\n");
}
function assistantText(parts) {
  return parts.filter((part) => part.type === "text").map((part) => part.text).filter(Boolean).join("\n");
}
function toTranscript(messages) {
  const out = [];
  const origins = [];
  messages.forEach((message, index) => {
    const push = (entry) => {
      out.push(entry);
      origins.push(index);
    };
    if (message.info.role === "user") {
      push({ role: "user", text: userText(message.parts), toolUses: [] });
      return;
    }
    const toolUses = [];
    const toolResults = [];
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const outcome = toolOutcome(part);
      if (!outcome) continue;
      toolUses.push({
        tool_use_id: part.callID,
        tool: part.tool,
        input: part.state.input,
        text: outcome.text,
        isError: outcome.isError
      });
      toolResults.push({ tool_use_id: part.callID, text: outcome.text, isError: outcome.isError });
    }
    push({ role: "assistant", text: assistantText(message.parts), toolUses });
    if (toolResults.length > 0) push({ role: "user", text: "", toolUses: [], toolResults });
  });
  return { messages: out, origins };
}
function preserveFor(transcript, sessionMessages, count2) {
  const first = sessionMessages - count2;
  return transcript.origins.filter((origin) => origin >= first).length;
}
function truncatePart(part, headChars) {
  if (part.state.status === "completed") {
    if (part.state.time.compacted) return part;
    const output = truncatedResultText(part.state.output, false, headChars);
    return output === part.state.output ? part : { ...part, state: { ...part.state, output } };
  }
  if (part.state.status === "error") {
    const error = truncatedResultText(part.state.error, true, headChars);
    return error === part.state.error ? part : { ...part, state: { ...part.state, error } };
  }
  return part;
}
function applyToSession(messages, actions, headChars) {
  return messages.map((message) => {
    if (message.info.role !== "assistant") return message;
    let changed = false;
    const parts = [];
    for (const part of message.parts) {
      if (part.type !== "tool") {
        parts.push(part);
        continue;
      }
      const action = actions.get(part.callID);
      if (action === "drop_call") {
        changed = true;
        continue;
      }
      if (action === "drop_result") {
        const next = truncatePart(part, headChars);
        if (next !== part) changed = true;
        parts.push(next);
        continue;
      }
      parts.push(part);
    }
    return changed ? { ...message, parts } : message;
  });
}
function replace(target, next) {
  target.length = 0;
  for (const item of next) target.push(item);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function getDroppedCallTools(transcript, outcome) {
  const dropped = [];
  outcome.actions.forEach((action, callID) => {
    if (action !== "drop_call") return;
    for (const msg of transcript.messages) {
      if (msg.role !== "assistant") continue;
      for (const tu of msg.toolUses ?? []) {
        if (tu.tool_use_id === callID) {
          dropped.push(tu.tool);
          return;
        }
      }
    }
  });
  return dropped;
}
var server = async (input, options) => {
  const config = readPrunerOptions(options ?? {});
  const log2 = (level, message) => Promise.resolve(
    input.client.app.log({ body: { service: "fast-jev-compaction", level, message } })
  ).catch(() => void 0);
  const toast = (message) => Promise.resolve(
    input.client.tui.showToast({
      body: { title: "fast-jev-compaction", message, variant: "info", duration: 1e4 }
    })
  ).catch(() => void 0);
  if (missingKey(config)) {
    await log2("warn", "TYPESAFE_API_KEY is not configured; Jev compaction is disabled");
    return {};
  }
  await log2("info", `Jev compaction enabled: ${describeProvider(config)}`);
  const fetchFn = options?.["fetch"];
  const pruner = new SessionPruner(
    jevClient(config, typeof fetchFn === "function" ? fetchFn : void 0),
    config
  );
  const limits = /* @__PURE__ */ new Map();
  return {
    "chat.params": async (params) => {
      limits.set(params.sessionID, params.model.limit.context);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const session = output.messages[0]?.info.sessionID;
      if (!session) return;
      try {
        const transcript = toTranscript(output.messages);
        const outcome = await pruner.prune(session, transcript.messages, {
          contextTokens: limits.get(session),
          preserveRecentMessages: preserveFor(
            transcript,
            output.messages.length,
            config.preserveRecentMessages
          )
        });
        if (outcome.actions.size > 0) {
          replace(
            output.messages,
            applyToSession(output.messages, outcome.actions, config.truncateHeadChars)
          );
        }
        if (outcome.reason === "pruned") {
          const dropped = getDroppedCallTools(transcript, outcome);
          const text = describeOutcome(outcome) + (dropped.length > 0 ? ` Dropped: ${dropped.join(", ")}` : "");
          await log2("info", text);
          await toast(text);
        }
      } catch (error) {
        await log2("warn", `left the history alone (${errorMessage(error)})`);
      }
    }
  };
};

// src/opencode/v2.ts
var CHECKPOINT_HEADER = "The earlier conversation, verbatim. Tool outputs that were no longer needed were truncated or removed; re-run a tool if its output is needed again.";
function stringify2(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function resultText(result) {
  if (result.type === "content") {
    return result.value.map(
      (item) => item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === void 0 ? "" : `: ${item.name}`}]`
    ).join("\n");
  }
  return typeof result.value === "string" ? result.value : stringify2(result.value);
}
function inputRecord(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : { input };
}
function textOf(content) {
  const lines = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) lines.push(part.text);
    } else if (part.type === "media") {
      const media = part;
      const mime = media.mediaType ?? media.media?.mime ?? "";
      const name = media.filename ?? "";
      lines.push(`[Attached ${mime}${name ? `: ${name}` : ""}]`);
    } else if (part.type === "compaction") {
      lines.push(
        part.text === void 0 ? "[Conversation checkpoint (encrypted)]" : `[Conversation checkpoint]
${part.text ?? ""}`
      );
    }
  }
  return lines.join("\n");
}
function toTranscript2(messages) {
  const results = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      results.set(part.id, { text: resultText(part.result), isError: part.result.type === "error" });
    }
  }
  const out = [];
  const origins = [];
  messages.forEach((message, index) => {
    const push = (entry) => {
      out.push(entry);
      origins.push(index);
    };
    if (message.role === "tool") {
      const toolResults = [];
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const found = results.get(part.id);
        if (found) toolResults.push({ tool_use_id: part.id, ...found });
      }
      push({ role: "user", text: "", toolUses: [], toolResults });
      return;
    }
    if (message.role === "assistant") {
      const toolUses = [];
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        const use = { tool_use_id: part.id, tool: part.name, input: inputRecord(part.input) };
        const found = results.get(part.id);
        if (found) {
          use.text = found.text;
          if (found.isError) use.isError = true;
        }
        toolUses.push(use);
      }
      push({ role: "assistant", text: textOf(message.content), toolUses });
      return;
    }
    const text = textOf(message.content);
    push({ role: "user", text: message.role === "system" && text ? `[System] ${text}` : text, toolUses: [] });
  });
  return { messages: out, origins };
}
function preserveFor2(transcript, modelMessages, count2) {
  const first = modelMessages - count2;
  return transcript.origins.filter((origin) => origin >= first).length;
}
function truncateResult(part, headChars) {
  const isError = part.result.type === "error";
  const text = resultText(part.result);
  const next = truncatedResultText(text, isError, headChars);
  if (next === text) return part;
  return { ...part, result: { type: isError ? "error" : "text", value: next } };
}
function withContent(message, content) {
  const proto = Object.getPrototypeOf(message);
  const ctor = proto?.constructor;
  if (proto && proto !== Object.prototype && typeof ctor === "function") {
    try {
      return new ctor({ ...message, content });
    } catch {
    }
  }
  return Object.assign(Object.create(proto), message, { content });
}
function applyToMessages(messages, actions, headChars) {
  const out = [];
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") {
      out.push(message);
      continue;
    }
    let changed = false;
    const content = [];
    for (const part of message.content) {
      if (part.type === "tool-call" || part.type === "tool-result") {
        const action = actions.get(part.id);
        if (action === "drop_call") {
          changed = true;
          continue;
        }
        if (action === "drop_result" && part.type === "tool-result") {
          const next = truncateResult(part, headChars);
          if (next !== part) changed = true;
          content.push(next);
          continue;
        }
      }
      content.push(part);
    }
    if (!changed) {
      out.push(message);
      continue;
    }
    if (content.length === 0) continue;
    out.push(withContent(message, content));
  }
  return out;
}
function getDroppedCallToolsV2(transcript, outcome) {
  const dropped = [];
  outcome.actions.forEach((action, callID) => {
    if (action !== "drop_call") return;
    for (const msg of transcript.messages) {
      if (msg.role !== "assistant") continue;
      for (const tu of msg.toolUses ?? []) {
        if (tu.tool_use_id === callID) {
          dropped.push(tu.tool);
          return;
        }
      }
    }
  });
  return dropped;
}
function log(message) {
  console.log(`[fast-jev-compaction] ${message}`);
}
var setup = async (ctx) => {
  const config = readPrunerOptions(ctx.options);
  if (missingKey(config)) {
    log("TYPESAFE_API_KEY is not configured; Jev compaction is disabled");
    return;
  }
  log(`Jev compaction enabled: ${describeProvider(config)}`);
  const fetchFn = ctx.options["fetch"];
  const pruner = new SessionPruner(
    jevClient(config, typeof fetchFn === "function" ? fetchFn : void 0),
    config
  );
  await ctx.session.hook("context", async (event) => {
    try {
      const transcript = toTranscript2(event.messages);
      const outcome = await pruner.prune(event.sessionID, transcript.messages, {
        preserveRecentMessages: preserveFor2(
          transcript,
          event.messages.length,
          config.preserveRecentMessages
        )
      });
      if (outcome.actions.size > 0) {
        event.messages = applyToMessages(event.messages, outcome.actions, config.truncateHeadChars);
      }
      if (outcome.reason === "pruned") {
        const dropped = getDroppedCallToolsV2(transcript, outcome);
        log(`${event.sessionID}: ${describeOutcome(outcome)}${dropped.length > 0 ? ` Dropped: ${dropped.join(", ")}` : ""}`);
      }
    } catch (error) {
      log(`${event.sessionID}: left the history alone (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  await ctx.session.hook("compaction", async (event) => {
    try {
      const transcript = toTranscript2(event.messages);
      const outcome = await pruner.prune(event.sessionID, transcript.messages, {
        force: true,
        preserveRecentMessages: preserveFor2(
          transcript,
          event.messages.length,
          config.preserveRecentMessages
        )
      });
      const pruned = applyActions(transcript.messages, outcome.actions, config.truncateHeadChars);
      const tokens = transcriptTokens(pruned);
      if (tokens > config.checkpointTokens) {
        log(
          `${event.sessionID}: built-in summary (verbatim history ~${tokens} tokens is above checkpointTokens ${config.checkpointTokens})`
        );
        return;
      }
      event.result = {
        summary: `${CHECKPOINT_HEADER}

${renderTranscript(pruned)}`,
        metadata: {
          "fast-jev-compaction": {
            tokens,
            messages: pruned.length,
            ...outcome.result ? outcome.result.stats : {},
            droppedTools: getDroppedCallToolsV2(transcript, outcome)
          }
        }
      };
      log(
        `${event.sessionID}: verbatim checkpoint, no summary (~${tokens} tokens; ${describeOutcome(outcome)})`
      );
    } catch (error) {
      log(`${event.sessionID}: built-in summary (${error instanceof Error ? error.message : String(error)})`);
    }
  });
};

// src/opencode/server.ts
function dual(plugin) {
  return plugin;
}
var server_default = dual({ id: "fast-jev-compaction", server, setup });
export {
  server_default as default
};
