export interface ProjectPathOptions {
    homeDir?: string;
    configDirName?: string;
    projectsDirName?: string;
    slugLength?: number;
    hashLength?: number;
}
export declare function sanitizePathComponent(value: string): string;
export declare function canonicalizePath(inputPath: string): string;
export declare function resolveProjectRoot(cwd: string): string;
export declare function getProjectSlug(cwd: string, options?: ProjectPathOptions): string;
export declare function getProjectHash(cwd: string, options?: ProjectPathOptions): string;
export declare function getProjectId(cwd: string, options?: ProjectPathOptions): string;
export declare function getPiProjectsDir(options?: ProjectPathOptions): string;
export declare function getPiProjectDir(cwd: string, options?: ProjectPathOptions): string;
export declare function getPiProjectSubdir(cwd: string, ...segments: string[]): string;
export declare function getPiProjectSubdir(cwd: string, options: ProjectPathOptions, ...segments: string[]): string;
export declare function getPiProjectAgentsFile(cwd: string, options?: ProjectPathOptions): string;
export declare function getPiProjectMemoryDir(cwd: string, options?: ProjectPathOptions): string;
export declare function getPiProjectMemorySubdir(cwd: string, ...segments: string[]): string;
export declare function getPiProjectMemorySubdir(cwd: string, options: ProjectPathOptions, ...segments: string[]): string;
