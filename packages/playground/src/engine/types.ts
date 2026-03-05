export interface PlaygroundOptions {
  preloadEntities?: any[];
  preloadData?: Record<string, any[]>;
}

export interface PlaygroundResult {
  success: boolean;
  output: any;
  sql: string[];
  duration: number;
  error?: string;
}
