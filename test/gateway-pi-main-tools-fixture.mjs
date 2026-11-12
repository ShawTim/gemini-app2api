// PI host tool interface shapes, with documentation text omitted. No App/runtime dependency.
const string = { type: 'string' }, number = { type: 'number' }, boolean = { type: 'boolean' };
const list = items => ({ type: 'array', items });
const object = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const choice = values => ({ anyOf: values.map(value => ({ type: 'string', const: value })) });
const tool = (name, properties = {}, required = []) => ({ type: 'function', function: { name, description: 'PI ' + name + ' interface', parameters: object(properties, required) } });
const paths = { path: string, file_path: string };
export const piMainTools = [
  tool('Read', { ...paths, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1 } }),
  tool('Glob', { pattern: string, query: string, path: string, limit: { type: 'number', minimum: 1 } }),
  tool('Grep', { pattern: string, query: string, path: string, include: string, outputMode: choice(['content', 'filesWithMatches', 'count']), headLimit: { type: 'number', minimum: 1 }, caseInsensitive: boolean }),
  tool('Write', { ...paths, content: string }, ['content']),
  tool('Edit', { ...paths, tag: string, ops: string, old_string: string, new_string: string }),
  tool('Bash', { command: string, timeout: { type: 'number', minimum: 1, maximum: 100000000 }, runInBackground: boolean }, ['command']),
  tool('BrowserPreview', paths),
  tool('TodoWrite', { todos: { type: 'array', maxItems: 50, items: object({ content: { type: 'string', minLength: 1 }, status: choice(['pending', 'in_progress', 'completed', 'cancelled']), priority: choice(['high', 'medium', 'low']) }, ['content', 'status']) } }, ['todos']),
  tool('GenerateImages', { items: { type: 'array', minItems: 1, maxItems: 10, items: object({ prompt: { type: 'string', minLength: 1, maxLength: 32000 }, images: { anyOf: [{ type: 'array', maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 4096 } }, { type: 'null' }] }, count: { type: 'integer', minimum: 1, maximum: 10 } }, ['prompt']) } }, ['items']),
  tool('asktool', { questions: list(object({ question: { type: 'string', maxLength: 300 }, options: list({ anyOf: [string, object({ label: string, description: string }, ['label'])] }), multiSelect: boolean }, ['question', 'options', 'multiSelect'])) }, ['questions']),
  tool('plugin_pi_browser_Browser', { action: choice(['navigate', 'snapshot', 'screenshot', 'click', 'fill', 'evaluate', 'console', 'cdp']), url: string, path: string, uid: string, text: string, expression: string, method: string, params: { type: 'object', additionalProperties: true }, fullPage: boolean, limit: number }, ['action']),
  tool('Task', { agent: choice(['explorer', 'code-reviewer', 'test-runner', 'fixer', 'ui-designer']), task: string, description: string, model: string, resume: string }, ['agent', 'task', 'description']),
  tool('TaskWait', { delegationIds: list(string), mode: choice(['all', 'any']), minCompleted: { type: 'number', minimum: 1 }, timeoutSeconds: { type: 'number', minimum: 1, maximum: 900 } }),
  tool('TaskStop', { delegationIds: list(string) }),
  tool('TaskList'), tool('EnterPlanMode'), tool('EnterGoalMode'), tool('new_context'),
  tool('Skill', { id: string }, ['id']),
  tool('ToolSearch', { query: { type: 'string', minLength: 1 } }, ['query']),
  tool('PluginScaffold', { template: string, directory: string, id: string, name: string }, ['template', 'directory']),
  tool('PluginCheck', { directory: string }, ['directory']), tool('PluginPack', { directory: string }, ['directory']),
];
