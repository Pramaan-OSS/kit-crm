export type Field = {
  column: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "timestamp";
  required?: boolean;
  max?: number;
  min?: number;
  options?: readonly string[];
  search?: boolean;
  readOnly?: boolean;
};
export const NOTE_FIELDS: readonly Field[] = [
  { column: "title", label: "Title", type: "text", required: true, max: 200, search: true },
  { column: "notes", label: "Notes", type: "text", required: true, max: 4000, search: true },
];
