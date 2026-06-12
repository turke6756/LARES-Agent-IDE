import React, { useState, useEffect, useRef } from 'react';
import type { AgentPersona, AgentProvider, AgentTemplate, Workspace } from '../../../shared/types';
import { PROVIDER_COMMANDS, PROVIDER_META } from '../../../shared/constants';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserSuspension } from '../browser/useBrowserSuspension';

const PROVIDERS: AgentProvider[] = ['claude', 'gemini', 'codex'];

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
  const [supervised, setSupervised] = useState(false);
  // Worker lane (hook-based status) — default ON. Only meaningful for
  // claude/codex (gemini has no hook scaffold); rendered disabled for gemini.
  const [worker, setWorker] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [agentMd, setAgentMd] = useState<{ found: boolean; fileName: string | null } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Template + Persona state
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedOption, setSelectedOption] = useState<string>(''); // "persona:name" or "template:id"
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // Create persona state
  const [showCreatePersona, setShowCreatePersona] = useState(false);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [creatingPersona, setCreatingPersona] = useState(false);

  // Load templates and personas on mount
  useEffect(() => {
    window.api.templates.list(workspace.id).then(setTemplates).catch(console.error);
    window.api.personas.list(workspace.path, workspace.pathType).then(list => {
      // Filter out supervisor — it auto-launches
      setPersonas(list.filter(p => !p.isSupervisor));
    }).catch(console.error);
  }, [workspace.id, workspace.path, workspace.pathType]);

  // Apply template or persona when selected
  useEffect(() => {
    if (!selectedOption) return;

    if (selectedOption.startsWith('template:')) {
      const templateId = selectedOption.slice('template:'.length);
      const template = templates.find(t => t.id === templateId);
      if (!template) return;
      if (template.roleDescription) setRoleDescription(template.roleDescription);
      if (template.provider) {
        setProvider(template.provider);
        setCommand(template.command || PROVIDER_COMMANDS[template.provider][workspace.pathType]);
      }
      if (template.command) setCommand(template.command);
      setAutoRestart(template.autoRestart);
      setSupervised(template.isSupervised);
      setWorker(template.isWorker);
      if (!title.trim()) setTitle(template.name);
    } else if (selectedOption.startsWith('persona:')) {
      const personaName = selectedOption.slice('persona:'.length);
      if (!title.trim()) {
        const displayName = personaName.charAt(0).toUpperCase() + personaName.slice(1).replace(/[-_]/g, ' ');
        setTitle(displayName);
      }
    }
  }, [selectedOption]);

  // Update command when provider changes (only if no template selected or manual change)
  useEffect(() => {
    if (!selectedOption.startsWith('template:')) {
      setCommand(PROVIDER_COMMANDS[provider][workspace.pathType]);
    }
  }, [provider, workspace.pathType]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLaunching(true);
    try {
      // If "New Template" is selected, scaffold the persona directory first
      let resolvedPersona: string | undefined;
      if (selectedOption === '__new_template__') {
        const personaName = title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (!personaName) {
          setLaunching(false);
          return;
        }
        const claudeMdContent = roleDescription.trim() || undefined;
        await window.api.personas.create(workspace.path, workspace.pathType, personaName, claudeMdContent);
        resolvedPersona = personaName;
      }

      const launchInput: any = {
        workspaceId: workspace.id,
        title: title.trim(),
        roleDescription: roleDescription.trim(),
        workingDirectory: workingDirectory.trim(),
        command: command.trim(),
        provider,
        autoRestartEnabled: autoRestart,
        isSupervised: supervised,
        // Worker lane: hook-based status. Gemini has no hook scaffold, so it
        // never joins the lane. Supervised implies worker.
        isWorker: provider !== 'gemini' && (worker || supervised),
      };

      if (resolvedPersona) {
        launchInput.persona = resolvedPersona;
      } else if (selectedOption.startsWith('template:')) {
        launchInput.templateId = selectedOption.slice('template:'.length);
      } else if (selectedOption.startsWith('persona:')) {
        launchInput.persona = selectedOption.slice('persona:'.length);
      }

      // Persona agents run in their own .claude/agents/<name>/ cwd, not the
      // shared worker folder — the worker lane does not apply to them.
      if (launchInput.persona) launchInput.isWorker = false;

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
        isSupervised: supervised,
        isWorker: worker,
      });
      setTemplates(prev => [...prev, newTemplate]);
      setSelectedOption(`template:${newTemplate.id}`);
      setShowSaveDialog(false);
      setSaveTemplateName('');
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleCreatePersona = async () => {
    if (!newPersonaName.trim()) return;
    setCreatingPersona(true);
    try {
      const persona = await window.api.personas.create(workspace.path, workspace.pathType, newPersonaName.trim());
      setPersonas(prev => [...prev, persona]);
      setSelectedOption(`persona:${persona.name}`);
      setShowCreatePersona(false);
      setNewPersonaName('');
    } catch (err: any) {
      console.error('Failed to create persona:', err);
      alert(err.message || 'Failed to create persona');
    } finally {
      setCreatingPersona(false);
    }
  };

  const hasOptions = templates.length > 0 || personas.length > 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="panel-shell w-[480px] max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold mb-3">Launch Agent</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Combined persona + template selector */}
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Persona / Template</label>
            <select
              value={selectedOption}
              onChange={(e) => setSelectedOption(e.target.value)}
              className="ui-input text-sm w-full"
            >
              <option value="">Ephemeral (no template)</option>
              <option value="__new_template__">+ New Template...</option>
              {personas.length > 0 && (
                <optgroup label="Personas">
                  {personas.map(p => (
                    <option key={`persona:${p.name}`} value={`persona:${p.name}`}>
                      {p.name}{p.hasMemory ? ' (has memory)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {templates.length > 0 && (
                <optgroup label="Templates">
                  {templates.map(t => (
                    <option key={`template:${t.id}`} value={`template:${t.id}`}>
                      {t.name}{t.workspaceId ? '' : ' (global)'}{t.systemPrompt ? ' *' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selectedOption.startsWith('template:') && (() => {
              const t = templates.find(x => x.id === selectedOption.slice('template:'.length));
              return t?.systemPrompt ? (
                <div className="mt-1 text-[11px] text-accent-blue">
                  Has system prompt ({t.systemPrompt.length} chars)
                </div>
              ) : null;
            })()}
            {selectedOption === '__new_template__' && (
              <div className="mt-1 text-[11px] text-accent-blue">
                Creates .claude/agents/{title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || '<agent-title>'}/ — Role Description becomes its CLAUDE.md
              </div>
            )}
            {selectedOption.startsWith('persona:') && (
              <div className="mt-1 text-[11px] text-accent-blue">
                Agent will run in .claude/agents/{selectedOption.slice('persona:'.length)}/ with its own CLAUDE.md
              </div>
            )}
            {/* Create new persona inline */}
            {showCreatePersona ? (
              <div className="flex items-center gap-2 mt-2 p-2 bg-surface-2 rounded-lg border border-gray-700">
                <input
                  type="text"
                  value={newPersonaName}
                  onChange={(e) => setNewPersonaName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                  placeholder="persona-name"
                  className="ui-input flex-1 text-sm font-mono"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreatePersona(); } }}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleCreatePersona}
                  disabled={!newPersonaName.trim() || creatingPersona}
                  className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
                >
                  {creatingPersona ? 'Creating...' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreatePersona(false); setNewPersonaName(''); }}
                  className="ui-btn ui-btn-ghost px-2 py-1.5 text-[13px]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreatePersona(true)}
                className="mt-1 text-[12px] text-gray-500 hover:text-accent-blue transition-colors"
              >
                + Create new persona...
              </button>
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
              {selectedOption === '__new_template__' ? 'Role Description (becomes this agent\'s CLAUDE.md)' : 'Role Description'}
            </label>
            <textarea
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              className="ui-textarea resize-none text-sm"
              rows={selectedOption === '__new_template__' ? 4 : 2}
              placeholder={selectedOption === '__new_template__' ? 'Define this agent\'s identity and behavior — this will be saved as CLAUDE.md' : 'What should this agent do?'}
            />
          </div>

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

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="worker"
              checked={provider !== 'gemini' && (worker || supervised)}
              disabled={provider === 'gemini' || supervised}
              onChange={(e) => setWorker(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="worker" className="text-sm text-gray-400">
              Worker (hook-based status)
              {provider === 'gemini' && (
                <span className="text-gray-600"> — unavailable for Gemini</span>
              )}
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="supervised"
              checked={supervised}
              onChange={(e) => { setSupervised(e.target.checked); if (e.target.checked) setWorker(true); }}
              className="rounded"
            />
            <label htmlFor="supervised" className="text-sm text-gray-400">
              Supervised (auto-notify supervisor on status changes)
            </label>
          </div>

          {/* Save as Template */}
          {showSaveDialog ? (
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
