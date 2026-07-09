import React, { useState, useRef, useEffect } from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useThemeStore } from '../../stores/theme-store';
import logoImg from '../../assets/logo.png';

// The spanning top chrome for the frameless window. The window is
// titleBarStyle:'hidden' + titleBarOverlay, so the native min/max/close buttons
// float top-right in a 32px band; this bar fills the rest of that band. It is
// the primary window-drag surface and the home for the app menus (File / View /
// Help) — the "one unit" tier that ties the three panels below into one app.
// The .titlebar class keeps interactive content clear of the native caption
// buttons via env(titlebar-area-*).

interface MenuItem {
  label: string;
  onClick?: () => void;
  divider?: boolean;
}

function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 app-no-drag"
      onClick={onClose}
    >
      <div className="ui-card p-6 max-w-sm text-center" onClick={(e) => e.stopPropagation()}>
        <img src={logoImg} alt="" className="h-12 w-12 mx-auto mb-3 object-contain" />
        <h2 className="text-[15px] font-semibold text-gray-100 mb-1">Lares</h2>
        <p className="text-[12px] text-gray-500 mb-4">
          Watch, direct, and collaborate with teams of AI agents — in one workspace.
        </p>
        <button onClick={onClose} className="ui-btn ui-btn-primary px-4 py-1.5 text-[13px]">
          Close
        </button>
      </div>
    </div>
  );
}

export default function TopBar() {
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const resetLayout = useDashboardStore((s) => s.resetLayout);
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);
  const { theme, toggleTheme } = useThemeStore();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  // Close the open menu on any outside click.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  const menus: Record<string, MenuItem[]> = {
    File: [
      {
        label: 'New Workspace…',
        onClick: () => window.dispatchEvent(new CustomEvent('dashboard:new-workspace')),
      },
      { label: 'Reload Workspaces', onClick: () => void loadWorkspaces() },
      { label: '', divider: true },
      { label: 'Close Window', onClick: () => window.close() },
    ],
    View: [
      { label: theme === 'dark' ? 'Light Theme' : 'Dark Theme', onClick: toggleTheme },
      { label: 'Reset Panel Layout', onClick: resetLayout },
      { label: '', divider: true },
      { label: 'Reload UI', onClick: () => window.location.reload() },
    ],
    Help: [{ label: 'About Lares', onClick: () => setShowAbout(true) }],
  };

  const handleItem = (item: MenuItem) => {
    setOpenMenu(null);
    item.onClick?.();
  };

  return (
    <div className="titlebar panel-header flex items-center shrink-0 app-drag-region text-[12px] select-none">
      {/* Brand mark */}
      <img src={logoImg} alt="" className="h-4 w-4 ml-2 mr-1 object-contain shrink-0 app-no-drag" />

      {/* App menus */}
      <nav ref={navRef} className="flex items-center app-no-drag">
        {Object.keys(menus).map((name) => (
          <div key={name} className="relative">
            <button
              onClick={() => setOpenMenu((cur) => (cur === name ? null : name))}
              // Once a menu is open, hovering a sibling switches to it (menu-bar feel).
              onMouseEnter={() => setOpenMenu((cur) => (cur ? name : cur))}
              className={`px-2.5 h-7 rounded-sm transition-colors ${
                openMenu === name
                  ? 'bg-white/10 text-gray-100'
                  : 'text-gray-300 hover:bg-white/5'
              }`}
            >
              {name}
            </button>
            {openMenu === name && (
              <div className="ui-menu absolute left-0 top-full mt-px z-50">
                {menus[name].map((item, i) =>
                  item.divider ? (
                    <div key={i} className="ui-menu-divider" />
                  ) : (
                    <button key={i} className="ui-menu-item" onClick={() => handleItem(item)}>
                      {item.label}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Center — active workspace (also a drag handle) */}
      <div className="flex-1 flex justify-center min-w-0 px-3">
        <span className="truncate text-gray-500">
          {workspace ? workspace.title : 'Lares'}
        </span>
      </div>

      {/* Right cluster — sits left of the native caption buttons (env inset). */}
      <div className="flex items-center gap-0.5 pr-1 app-no-drag">
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="h-7 w-7 flex items-center justify-center rounded-sm text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
        >
          {theme === 'dark' ? (
            <Icons.Sun className="w-3.5 h-3.5" />
          ) : (
            <Icons.Moon className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}
