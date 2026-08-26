/**
 * Structural traversal of a form. Shared by the resolver and the validator so
 * both agree on what "a field" is and on how a location is named in an error.
 */

import type { Field, Form, RepeatableField, Section, TableField } from "./types.js";

/** The two structures with user-mutable rows (§4.5). `$self` scopes to these. */
export type ContainerField = RepeatableField | TableField;

export type FieldRole =
  /** Declared directly in a section. */
  | "field"
  /** A `repeatable` sub-field definition. */
  | "subfield"
  /** A `table` column definition. */
  | "column";

export type FieldVisit = {
  field: Field;
  role: FieldRole;
  section: Section;
  sectionIndex: number;
  /** Index within its own list (section fields, sub-fields, or columns). */
  index: number;
  /** Dotted location for error messages: `sections[0].fields[3].columns[1]`. */
  location: string;
  /** Enclosing containers, outermost first. Empty for a top-level field. */
  containers: ContainerField[];
};

export function isContainer(field: Field): field is ContainerField {
  return field.type === "repeatable" || field.type === "table";
}

/** Members a container declares: sub-fields for `repeatable`, columns for `table`. */
export function containerMembers(container: ContainerField): Field[] {
  return container.type === "repeatable" ? container.fields : container.columns;
}

export function sectionLocation(index: number): string {
  return `sections[${index}]`;
}

/**
 * Every field in the form, depth-first, including `repeatable` sub-fields and
 * `table` columns.
 */
export function* walkFields(form: Form): Generator<FieldVisit> {
  for (const [sectionIndex, section] of form.sections.entries()) {
    for (const [index, field] of section.fields.entries()) {
      yield* walkField({
        field,
        role: "field",
        section,
        sectionIndex,
        index,
        location: `${sectionLocation(sectionIndex)}.fields[${index}]`,
        containers: [],
      });
    }
  }
}

function* walkField(visit: FieldVisit): Generator<FieldVisit> {
  yield visit;
  const { field } = visit;
  if (field.type === "repeatable") {
    for (const [index, sub] of field.fields.entries()) {
      yield* walkField({
        ...visit,
        field: sub,
        role: "subfield",
        index,
        location: `${visit.location}.fields[${index}]`,
        containers: [...visit.containers, field],
      });
    }
  } else if (field.type === "table") {
    for (const [index, column] of field.columns.entries()) {
      yield* walkField({
        ...visit,
        field: column,
        role: "column",
        index,
        location: `${visit.location}.columns[${index}]`,
        containers: [...visit.containers, field],
      });
    }
  }
}

/** Top-level fields only (the ones a bare path addresses). */
export function topLevelFields(form: Form): { field: Field; section: Section }[] {
  return form.sections.flatMap((section) => section.fields.map((field) => ({ field, section })));
}

/**
 * Every container chain in the form, outermost first — the candidate scopes a
 * `$self` path may be interpreted in when no scope is supplied.
 */
export function containerChains(form: Form): { chain: ContainerField[]; section: Section }[] {
  const chains: { chain: ContainerField[]; section: Section }[] = [];
  for (const visit of walkFields(form)) {
    if (isContainer(visit.field)) {
      chains.push({
        chain: [...visit.containers, visit.field],
        section: visit.section,
      });
    }
  }
  return chains;
}
