export interface FlatDialogNode {
  type: "npc" | "pc";
  index: number;
  text: string;
  script?: string;
  condition?: string;
  children: FlatDialogNode[];
  isLeaf: boolean;
}

export interface DialogPath {
  nodes: Array<{
    type: "npc" | "pc";
    index: number;
    text: string;
    script?: string;
  }>;
}

export interface DialogScriptRef {
  dialog: string;
  nodeType: "entry" | "reply";
  nodeIndex: number;
  fieldName: string;
  scriptResref: string;
  text: string;
}
