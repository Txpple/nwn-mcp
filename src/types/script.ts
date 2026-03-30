export interface VariableRef {
  name: string;
  operation: "get" | "set" | "delete";
  type: "int" | "string" | "float" | "object" | "location";
  scriptResref: string;
  line?: number;
  context?: string;
}

export interface ScriptInfo {
  resref: string;
  hasSource: boolean;
  hasCompiled: boolean;
  referencedBy: Array<{ resourceFile: string; gffPath: string; usageType: string }>;
  variablesUsed: VariableRef[];
  functionsCalled: string[];
}
