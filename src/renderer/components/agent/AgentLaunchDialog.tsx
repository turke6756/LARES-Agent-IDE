import React, { useState, useEffect, useRef } from 'react';
import type { AgentPersona, AgentProvider, AgentTemplate, PersonaLane, Workspace } from '../../../shared/types';
import { PROVIDER_COMMANDS, PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserSuspension } from '../browser/useBrowserSuspension';

const PROVIDERS: AgentProvider[] = ['claude', 'gemini', 'codex'];

// Single "Agent type" selector values. The first three are first-class role
// lanes (app-managed cwd + scaffold under .dashboard/); personas are custom
// agent types (.dashboard/agents/<name>/); templates are advanced DB presets;
// ephemeral is the only no-lane / project-root / no-scaffold path.
const TYPE_WORKER = 'role:worker';
const TYPE_SUPERVISOR = 'role:supervisor';
const TYPE_RESEARCHER = 'role:researcher';
const TYPE_NEW_AGENT = '__new_agent__';
const TYPE_EPHEMERAL = 'ephemeral';

interface Props {
  workspace: Workspace;
  onClose: () => void;
}

export default function AgentLaunchDialog({ workspace, onClose }: Props) {
  // The browser WebContentsView paints above this dialog — hide it while open.
  useBrowserSuspension();
  const { loadAgents, checkHealth } = useDashboardStore();
  const [title, setTitle] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(workspace.path);
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [command, setCommand] = useState(PROVIDER_COMMANDS.claude[workspace.pathType]);
  const [autoRestart, setAutoRestart] = useState(true);
  // Workers launch UNSUPERVISED by default; the user opts in via this checkbox.
  const [supervised, setSupervised] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [agentMd, setAgentMd] = useState<{ found: boolean; fileName: string | null } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Templates + personas (custom agents)
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  // The single "Agent type" choice. Worker is the explicit default.
  const [selectedType, setSelectedType] = useState<string>(TYPE_WORKER);
  // #18 — optional privilege lane for a NEW persona. '' = none (native tools
  // only). Backend reads the declared lane from persona.json at launch (D6); the
  // renderer never spreads lane flags into launchInput.
  const [newPersonaLane, setNewPersonaLane] = useState<PersonaLane | ''>('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // ── Derived selection kind ──────────────────────────────────────────
  const isSupervisorType = selectedType === TYPE_SUPERVISOR;
  const isResearcherType = selectedType === TYPE_RESEARCHER;
  const isWorkerType = selectedType === TYPE_WORKER;
  const isNewAgent = selectedType === TYPE_NEW_AGENT;
  const isPersona = selectedType.startsWith('persona:');
  const isTemplate = selectedType.startsWith('template:');
  const isEphemeral = selectedType === TYPE_EPHEMERAL;
  // Supervisor + researcher are Claude-only app-managed lanes: the app owns
  // their cwd, command, tools, and MCP, so provider/command/working-dir are
  // hidden and provider is forced to claude.
  const appManaged = isSupervisorType || isResearcherType;
  const showProviderAndCommand = !appManaged;
  // Working directory is only meaningful where the user actually controls the
  // cwd: templates and the raw ephemeral session. Role lanes + personas derive
  // their cwd from the workspace root in the backend.
  const showWorkingDir = isTemplate || isEphemeral;

  // Load templates and personas on mount
  useEffect(() => {
    window.api.templates.list(workspace.id).then(setTemplates).catch(console.error);
    window.api.personas.list(workspace.path, workspace.pathType).then(list => {
      // Filter out supervisor — it's a role-lane option, not a custom agent.
      setPersonas(list.filter(p => !p.isSupervisor));
    }).catch(console.error);
  }, [workspace.id, workspace.path, workspace.pathType]);

  // Apply template defaults / autofill title when the type changes.
  useEffect(() => {
    if (isSupervisorType || isResearcherType) {
      setProvider('claude');
      return;
    }
    if (isTemplate) {
      const templateId = selectedType.slice('template:'.length);
      const template = templates.find(t => t.id === templateId);
      if (!template) return;
      if (template.roleDescription) setRoleDescription(template.roleDescription);
      if (template.provider) {
        setProvider(template.provider);
        setCommand(template.command || PROVIDER_COMMANDS[template.provider][workspace.pathType]);
      }
      if (template.command) setCommand(template.command);
      setAutoRestart(template.autoRestart);
      if (!title.trim()) setTitle(template.name);
    } else if (isPersona) {
      const personaName = selectedType.slice('persona:'.length);
      if (!title.trim()) {
        const displayName = personaName.charAt(0).toUpperCase() + personaName.slice(1).replace(/[-_]/g, ' ');
        setTitle(displayName);
      }
    }
  }, [selectedType]);

  // Update command when provider changes (only if not bound to a template).
  useEffect(() => {
    if (!isTemplate) {
      setCommand(PROVIDER_COMMANDS[provider][workspace.pathType]);
    }
  }, [provider, workspace.pathType]);

  // #18 — a researcher-lane persona is Claude-only (the backend forces
  // provider=claude and would otherwise throw at launch). Force it here so the
  // UI never offers a doomed combo.
  useEffect(() => {
    if (isNewAgent && newPersonaLane === 'researcher' && provider !== 'claude') {
      setProvider('claude');
    }
  }, [isNewAgent, newPersonaLane, provider]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!workingDirectory.trim()) {
        setAgentMd(null);
        return;
      }
      try {
        const result = await window.api.agents.checkAgentMd(workingDirectory.trim(), workspace.pathType);
        setAgentMd(result);
      } catch {
        setAgentMd(null);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [workingDirectory, workspace.pathType]);

  // Persona name minted from the title for the "+ New agent…" path.
  const newAgentSlug = title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLaunching(true);
    try {
      const base: any = {
        workspaceId: workspace.id,
        title: title.trim(),
        roleDescription: roleDescription.trim(),
        autoRestartEnabled: autoRestart,
      };

      let launchInput: any;

      if (isSupervisorType) {
        // Supervisor role-lane → .dashboard/supervisor/, ensureSupervisorScaffold.
        // Multiple supervisors per workspace are allowed (backend no longer blocks).
        launchInput = { ...base, provider: 'claude', isSupervisor: true, workingDirectory: workspace.path };
      } else if (isResearcherType) {
        // Researcher role-lane → .dashboard/researcher/, ensureResearcherScaffold.
        // App-managed cwd/command/tools/browser-MCP; Claude-only (backend rejects
        // non-claude). Supervised by default.
        launchInput = {
          ...base,
          provider: 'claude',
          workingDirectory: workspace.path,
          isResearcher: true,
          isSupervised: true,
        };
      } else if (isWorkerType) {
        // Worker role-lane → .dashboard/workers/<provider>/, ensureWorkerScaffold.
        // Hook-based status; gemini has no hook scaffold so it never joins the
        // lane. Unsupervised by default — the user opts into supervision via the
        // "Supervised" checkbox.
        launchInput = {
          ...base,
          workingDirectory: workspace.path,
          command: command.trim(),
          provider,
          isWorker: provider !== 'gemini',
          isSupervised: supervised && provider !== 'gemini',
        };
      } else if (isNewAgent) {
        // Mint a fresh persona under .dashboard/agents/<slug>/ then launch it.
        if (!newAgentSlug) { setLaunching(false); return; }
        await window.api.personas.create(
          workspace.path, workspace.pathType, newAgentSlug, roleDescription.trim() || undefined,
          newPersonaLane || undefined,
        );
        launchInput = {
          ...base,
          workingDirectory: workspace.path,
          command: command.trim(),
          provider,
          persona: newAgentSlug,
        };
      } else if (isPersona) {
        // Existing custom agent → runs in its own .dashboard/agents/<name>/ cwd.
        launchInput = {
          ...base,
          workingDirectory: workspace.path,
          command: command.trim(),
          provider,
          persona: selectedType.slice('persona:'.length),
        };
      } else if (isTemplate) {
        // Advanced DB template — keep its existing semantics.
        launchInput = {
          ...base,
          workingDirectory: workingDirectory.trim() || workspace.path,
          command: command.trim(),
          provider,
          templateId: selectedType.slice('template:'.length),
        };
      } else {
        // Ephemeral (raw session): the ONLY no-lane path — legacy lane, cwd =
        // project root, no persona, no scaffold, no hooks.
        launchInput = {
          ...base,
          workingDirectory: workingDirectory.trim() || workspace.path,
          command: command.trim(),
          provider,
        };
      }

      await window.api.agents.launch(launchInput);
      await loadAgents(workspace.id);
      if (workspace.pathType === 'wsl') {
        await checkHealth();
      }
      onClose();
    } catch (err) {
      console.error('Failed to launch agent:', err);
      setLaunching(false);
    }
  };

  const handlePickDir = async () => {
    const dir = await window.api.system.pickDirectory();
    if (dir) setWorkingDirectory(dir);
  };

  const handleSaveTemplate = async () => {
    if (!saveTemplateName.trim()) return;
    setSavingTemplate(true);
    try {
      const newTemplate = await window.api.templates.create({
        workspaceId: workspace.id,
        name: saveTemplateName.trim(),
        description: roleDescription.trim(),
        roleDescription: roleDescription.trim(),
        provider,
        command: command.trim() || null,
        autoRestart,
        // Persist worker/supervised intent from the selected role lane.
        isSupervised: isWorkerType && supervised && provider !== 'gemini',
        isWorker: isWorkerType && provider !== 'gemini',
      });
      setTemplates(prev => [...prev, newTemplate]);
      setSelectedType(`template:${newTemplate.id}`);
      setShowSaveDialog(false);
      setSaveTemplateName('');
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="panel-shell w-[480px] max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold mb-3">Launch Agent</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Single "Agent type" selector — role lanes, custom agents, templates,
              and the raw ephemeral session, all in one explicit choice. */}
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Agent type</label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="ui-input text-sm w-full"
            >
              <option value={TYPE_WORKER}>Worker</option>
              <option value={TYPE_SUPERVISOR}>Supervisor</option>
              <option value={TYPE_RESEARCHER}>Researcher</option>
              {personas.length > 0 && (
                <optgroup label="— your custom agents —">
                  {personas.map(p => (
                    <option key={`persona:${p.name}`} value={`persona:${p.name}`}>
                      {p.name}{p.lane ? ` (${p.lane})` : ''}{p.hasMemory ? ' (has memory)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={TYPE_NEW_AGENT}>+ New agent…</option>
              {templates.length > 0 && (
                <optgroup label="Templates (advanced)">
                  {templates.map(t => (
                    <option key={`template:${t.id}`} value={`template:${t.id}`}>
                      {t.name}{t.workspaceId ? '' : ' (global)'}{t.systemPrompt ? ' *' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={TYPE_EPHEMERAL}>Ephemeral (raw session)</option>
            </select>

            {/* Per-type hint line */}
            {isWorkerType && (
              <div className="mt-1 text-[11px] text-gray-500">
                Hook-based worker in .dashboard/workers/{provider}/ — unsupervised by default.
              </div>
            )}
            {isSupervisorType && (
              <div className="mt-1 text-[11px] text-gray-500">
                Runs in .dashboard/supervisor/ with the supervisor scaffold (Claude only).
              </div>
            )}
            {isResearcherType && (
              <div className="mt-1 text-[11px] text-gray-500">
                Browses + researches the web in an app-managed sandbox (Claude only; never edits code).
              </div>
            )}
            {isPersona && (
              <div className="mt-1 text-[11px] text-accent-blue">
                Runs in .dashboard/agents/{selectedType.slice('persona:'.length)}/ with its own CLAUDE.md.
              </div>
            )}
            {isNewAgent && (
              <div className="mt-1 text-[11px] text-accent-blue">
                Creates .dashboard/agents/{newAgentSlug || '<agent-title>'}/ — Role Description becomes its CLAUDE.md.
              </div>
            )}
            {isTemplate && (() => {
              const t = templates.find(x => x.id === selectedType.slice('template:'.length));
              return t?.systemPrompt ? (
                <div className="mt-1 text-[11px] text-accent-blue">
                  Has system prompt ({t.systemPrompt.length} chars)
                </div>
              ) : null;
            })()}
            {isEphemeral && (
              <div className="mt-1 text-[11px] text-gray-500">
                Raw session at the project root — no persona, no scaffold, no status hooks.
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Agent Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="ui-input text-sm"
              placeholder="e.g. Feature Builder"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">
              {isNewAgent ? 'Role Description (becomes this agent\'s CLAUDE.md)' : 'Role Description'}
            </label>
            <textarea
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              className="ui-textarea resize-none text-sm"
              rows={isNewAgent ? 4 : 2}
              placeholder={isNewAgent ? 'Define this agent\'s identity and behavior — this will be saved as CLAUDE.md' : 'What should this agent do?'}
            />
          </div>

          {/* #18 — optional privilege lane for a NEW persona. Backend reads the
              declared lane from persona.json at launch (D6); we only persist the
              choice here, never spread lane flags into launchInput. */}
          {isNewAgent && (
            <div>
              <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Privilege Lane</label>
              <select
                value={newPersonaLane}
                onChange={(e) => setNewPersonaLane(e.target.value as PersonaLane | '')}
                className="ui-input text-sm"
              >
                <option value="">None</option>
                <option value="worker">Worker</option>
                <option value="researcher">Researcher</option>
                <option value="supervisor">Supervisor</option>
              </select>
              <div className="mt-1 text-[11px] text-gray-500">
                Grants this persona the dashboard tools of one native lane. None = native tools only.
                {newPersonaLane === 'researcher' && ' Researcher is Claude-only — provider forced to Claude.'}
              </div>
            </div>
          )}

          {showWorkingDir && (
            <div>
              <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Working Directory</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={workingDirectory}
                  onChange={(e) => setWorkingDirectory(e.target.value)}
                  className="ui-input flex-1 text-sm font-sans"
                />
                <button
                  type="button"
                  onClick={handlePickDir}
                  className="ui-btn ui-btn-ghost px-3 py-2 text-sm"
                >
                  Browse
                </button>
              </div>
              {agentMd && agentMd.found && (
                <div className="mt-1.5 inline-flex items-center gap-1 bg-green-500/15 text-green-400 text-[13px] px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                  {agentMd.fileName} found
                </div>
              )}
              {agentMd && !agentMd.found && (
                <div className="mt-1.5 text-[13px] text-gray-400">
                  No agent.md
                </div>
              )}
            </div>
          )}

          {showProviderAndCommand && (
          <>
          {/* Provider selector */}
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Provider</label>
            <div className="flex gap-1">
              {PROVIDERS.map((p) => {
                const meta = PROVIDER_META[p];
                const isActive = provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(p)}
                    className={`ui-btn flex-1 px-3 py-2 text-[13px] font-sans font-bold
                      ${isActive
                        ? `${meta.bgClass} ${meta.textClass} border-current shadow-[0_10px_18px_rgba(0,0,0,0.18)]`
                        : 'ui-btn-ghost'
                      }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
            {isWorkerType && provider === 'gemini' && (
              <div className="mt-1 text-[11px] text-gray-600">
                Gemini has no hook scaffold — it launches as a plain session, not a worker-lane agent.
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="ui-input text-sm font-sans"
            />
          </div>
          </>
          )}

          {isWorkerType && provider !== 'gemini' && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="supervised"
                checked={supervised}
                onChange={(e) => setSupervised(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="supervised" className="text-sm text-gray-400">
                Supervised (a supervisor watches status and routes questions)
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoRestart"
              checked={autoRestart}
              onChange={(e) => setAutoRestart(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="autoRestart" className="text-sm text-gray-400">
              Auto-restart on crash
            </label>
          </div>

          {/* Save as Template (advanced) — captures the current provider/command/
              role-description as a reusable DB preset. */}
          {showProviderAndCommand && (
            showSaveDialog ? (
              <div className="flex items-center gap-2 p-2 bg-surface-2 rounded-lg border border-gray-700">
                <input
                  type="text"
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  placeholder="Template name..."
                  className="ui-input flex-1 text-sm"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveTemplate(); } }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleSaveTemplate}
                  disabled={!saveTemplateName.trim() || savingTemplate}
                  className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
                >
                  {savingTemplate ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowSaveDialog(false)}
                  className="ui-btn ui-btn-ghost px-2 py-1.5 text-[13px]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowSaveDialog(true)}
                className="text-[13px] text-gray-500 hover:text-accent-blue transition-colors"
              >
                Save as template...
              </button>
            )
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn ui-btn-ghost px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || launching}
              className="ui-btn ui-btn-primary px-4 py-2 text-sm font-medium"
            >
              {launching ? 'Launching...' : 'Launch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
