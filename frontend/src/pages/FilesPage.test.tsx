import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { api } from '../lib/api';
import { ToastProvider } from '../components/Toast';
import { FilesPage } from './FilesPage';

vi.mock('../lib/api', () => ({ api: vi.fn(), uploadForm: vi.fn() }));
vi.mock('../components/PreviewPanel', () => ({ PreviewPanel: () => null }));

const apiMock = vi.mocked(api);

afterEach(() => apiMock.mockReset());

describe('FilesPage local-device status', () => {
  it('shows the live paired-device state while clarifying project files remain separate', async () => {
    apiMock.mockImplementation(async <T,>(path: string): Promise<T> => {
      if (path === '/api/v1/local-workspace/devices') {
        return { devices: [{ id: 'd1', name: 'Laptop', state: 'PAIRED', presence: 'ONLINE' }] } as T;
      }
      if (path === '/api/v1/projects') return { projects: [] } as T;
      if (path.startsWith('/api/v1/files/tree')) return { tree: [] } as T;
      if (path.startsWith('/api/v1/files')) return { files: [] } as T;
      return {} as T;
    });

    render(<ToastProvider><FilesPage /></ToastProvider>);

    await waitFor(() => expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('ONLINE'));
    expect(screen.getByText(/Project files here are stored in CodeConClave/)).toBeInTheDocument();
  });
});
