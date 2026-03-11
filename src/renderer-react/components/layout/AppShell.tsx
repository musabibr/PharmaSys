import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { ConnectionOverlay } from './ConnectionOverlay';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

/** App shell — sidebar + header + page content outlet. */
export function AppShell() {
  useKeyboardShortcuts();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onChangePassword={() => setChangePasswordOpen(true)} />
        <main className="flex-1 overflow-auto p-density">
          <Outlet />
        </main>
      </div>
      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />
      <ConnectionOverlay />
    </div>
  );
}
