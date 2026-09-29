// File System Access API pieces not in TypeScript's DOM lib (Chromium; WICG spec).
interface FilePickerAcceptType { description?: string; accept: Record<string, string | string[]> }
interface FilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  id?: string;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}
interface OpenFilePickerOptions extends FilePickerOptions { multiple?: boolean }
interface SaveFilePickerOptions extends FilePickerOptions { suggestedName?: string }
interface DirectoryPickerOptions { id?: string; mode?: 'read' | 'readwrite'; startIn?: FilePickerOptions['startIn'] }
interface FileSystemHandlePermissionDescriptor { mode?: 'read' | 'readwrite' }

interface FileSystemHandle {
  queryPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}

interface Window {
  showOpenFilePicker?(o?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
