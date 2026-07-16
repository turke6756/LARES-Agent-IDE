export type FileType =
  | 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'docx' | 'notebook' | 'csv'
  | 'geotiff' | 'shapefile' | 'geopackage'
  | 'binary';

const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);
const CSV_EXTS = new Set(['.csv', '.tsv']);
const GEOTIFF_EXTS = new Set(['.tif', '.tiff']);
const SHAPEFILE_EXTS = new Set(['.shp']);
const GEOPACKAGE_EXTS = new Set(['.gpkg']);

const CODE_EXTS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby',
  '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.cs': 'csharp', '.swift': 'swift', '.php': 'php', '.r': 'r',
  '.sql': 'sql', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
  '.html': 'html', '.htm': 'html', '.xml': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.sass': 'sass',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.dockerfile': 'dockerfile', '.docker': 'dockerfile',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.lua': 'lua', '.vim': 'vim', '.el': 'lisp',
  '.zig': 'zig', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hs': 'haskell', '.ml': 'ocaml',
  '.proto': 'protobuf', '.tf': 'hcl',
  '.makefile': 'makefile', '.cmake': 'cmake',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.svg']);
const PDF_EXTS = new Set(['.pdf']);
const DOCX_EXTS = new Set(['.docx']);
const NOTEBOOK_EXTS = new Set(['.ipynb', '.pynb']);

const BINARY_EXTS = new Set([
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.doc', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3',
]);

const TEXT_EXTS = new Set([
  '.txt', '.log', '.env', '.gitignore', '.gitattributes', '.editorconfig',
  '.prettierrc', '.eslintrc', '.npmrc', '.nvmrc',
]);

function getExtension(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() || '';

  // Handle special filenames
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return '.dockerfile';
  if (lower === 'makefile') return '.makefile';

  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.substring(dotIndex).toLowerCase();
}

export function detectFileType(filePath: string): FileType {
  const ext = getExtension(filePath);
  if (!ext) return 'text';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (CSV_EXTS.has(ext)) return 'csv';
  if (GEOTIFF_EXTS.has(ext)) return 'geotiff';
  if (SHAPEFILE_EXTS.has(ext)) return 'shapefile';
  if (GEOPACKAGE_EXTS.has(ext)) return 'geopackage';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (DOCX_EXTS.has(ext)) return 'docx';
  if (NOTEBOOK_EXTS.has(ext)) return 'notebook';
  if (ext in CODE_EXTS) return 'code';
  if (BINARY_EXTS.has(ext)) return 'binary';
  if (TEXT_EXTS.has(ext)) return 'text';
  // Unknown extension - treat as text
  return 'text';
}

export function isNotebookFile(filePath: string): boolean {
  return NOTEBOOK_EXTS.has(getExtension(filePath));
}

export function isInteractiveNotebookFile(filePath: string): boolean {
  return getExtension(filePath) === '.ipynb';
}

export function isEditableFileType(filePath: string): boolean {
  const type = detectFileType(filePath);
  return type === 'markdown' || type === 'text' || type === 'code';
}

export function detectLanguage(filePath: string): string {
  const ext = getExtension(filePath);
  return CODE_EXTS[ext] || 'text';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIconName(filePath: string, isDirectory: boolean): string {
  if (isDirectory) return 'Folder';

  const name = filePath.split(/[/\\]/).pop() || '';
  const lowerName = name.toLowerCase();
  const ext = (name.includes('.') ? '.' + name.split('.').pop() : '').toLowerCase();

  // Special filenames
  if (lowerName === 'package.json') return 'Package';
  if (lowerName === 'package-lock.json') return 'Lock';
  if (lowerName === 'tsconfig.json') return 'Settings2';
  if (lowerName === '.gitignore') return 'GitBranch';
  if (lowerName === 'dockerfile') return 'Container';
  if (lowerName === 'makefile') return 'FileTerminal';
  if (lowerName.includes('license')) return 'FileCheck';
  
  const type = detectFileType(filePath);

  switch (type) {
    case 'markdown': return 'FileText';
    case 'csv': return 'Sheet';
    case 'geotiff': return 'Map';
    case 'shapefile': return 'Map';
    case 'geopackage': return 'Map';
    case 'image': return 'FileImage';
    case 'pdf': return 'FileText'; // FileText as placeholder if FileArchive isn't right
    case 'docx': return 'FileText';
    case 'notebook': return 'BookOpen';
    case 'code':
      if (['.ts', '.tsx'].includes(ext)) return 'FileType2';
      if (['.js', '.jsx'].includes(ext)) return 'FileType';
      if (['.json'].includes(ext)) return 'Braces';
      if (['.css', '.scss', '.less'].includes(ext)) return 'Palette';
      if (['.html', '.xml', '.svg'].includes(ext)) return 'Code2';
      if (['.py'].includes(ext)) return 'FileCode2';
      if (['.rs', '.go', '.rb', '.java', '.kt', '.c', '.cpp', '.cs'].includes(ext)) return 'Cpu';
      if (['.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1'].includes(ext)) return 'Terminal';
      if (['.sql'].includes(ext)) return 'Database';
      return 'FileCode';
    case 'text':
      if (['.log'].includes(ext)) return 'ScrollText';
      if (['.env', '.ini', '.cfg', '.conf', '.toml', '.yaml', '.yml'].includes(ext)) return 'Settings';
      return 'FileText';
    case 'binary':
      if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'Archive';
      if (['.exe', '.dll', '.bin'].includes(ext)) return 'Binary';
      if (['.db', '.sqlite', '.sqlite3'].includes(ext)) return 'Database';
      return 'FileBox';
    default: return 'File';
  }
}

export function getFileIconColor(filePath: string, isDirectory: boolean): string {
  if (isDirectory) return 'var(--color-icon-folder)';

  const name = filePath.split(/[/\\]/).pop() || '';
  const lowerName = name.toLowerCase();
  const ext = (name.includes('.') ? '.' + name.split('.').pop() : '').toLowerCase();

  if (lowerName === 'package.json') return 'var(--color-icon-package)';
  if (lowerName === 'package-lock.json' || lowerName === 'yarn.lock' || lowerName === 'pnpm-lock.yaml') return 'var(--color-icon-lock)';
  if (lowerName === 'tsconfig.json') return 'var(--color-icon-ts)';
  if (lowerName === '.gitignore' || lowerName === '.gitattributes') return 'var(--color-icon-config)';
  if (lowerName === 'dockerfile') return 'var(--color-icon-md)';
  if (lowerName === 'makefile') return 'var(--color-icon-shell)';
  if (lowerName.includes('license')) return 'var(--color-icon-config)';

  const type = detectFileType(filePath);
  switch (type) {
    case 'markdown': return 'var(--color-icon-md)';
    case 'csv': return 'var(--color-icon-db)';
    case 'geotiff':
    case 'shapefile':
    case 'geopackage':
      return 'var(--color-accent-green)';
    case 'image': return 'var(--color-icon-image)';
    case 'pdf': return 'var(--color-icon-package)';
    case 'docx': return 'var(--color-accent-blue)';
    case 'notebook': return 'var(--color-icon-py)';
    case 'code':
      if (['.ts', '.tsx'].includes(ext)) return 'var(--color-icon-ts)';
      if (['.js', '.jsx'].includes(ext)) return 'var(--color-icon-js)';
      if (['.json'].includes(ext)) return 'var(--color-icon-json)';
      if (['.css', '.scss', '.less', '.sass'].includes(ext)) return 'var(--color-icon-css)';
      if (['.html', '.htm'].includes(ext)) return 'var(--color-icon-html)';
      if (['.xml', '.svg'].includes(ext)) return 'var(--color-icon-html)';
      if (['.py'].includes(ext)) return 'var(--color-icon-py)';
      if (['.rs', '.go', '.rb', '.java', '.kt', '.c', '.cpp', '.cs', '.swift', '.r'].includes(ext)) return 'var(--color-icon-default)';
      if (['.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1'].includes(ext)) return 'var(--color-icon-shell)';
      if (['.sql'].includes(ext)) return 'var(--color-icon-db)';
      return 'var(--color-icon-default)';
    case 'text':
      if (['.log'].includes(ext)) return 'var(--color-icon-default)';
      if (['.env', '.ini', '.cfg', '.conf', '.toml', '.yaml', '.yml'].includes(ext)) return 'var(--color-icon-config)';
      return 'var(--color-icon-default)';
    case 'binary':
      if (['.db', '.sqlite', '.sqlite3'].includes(ext)) return 'var(--color-icon-db)';
      return 'var(--color-icon-binary)';
    default: return 'var(--color-icon-default)';
  }
}
