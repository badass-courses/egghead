import type { ThemeRegistration } from "shiki";

/*
 * Code themes from the egghead brand palette (packages/ui tokens.css):
 * keywords in rust, strings in sage, constants in yolk, types in sky,
 * comments in pencil. Light sits on the cream well (#f6edd8), dark on
 * the night well (#101926); backgrounds match so highlighted blocks
 * blend with .egghead-prose pre styling.
 */

export const eggheadCodeLight: ThemeRegistration = {
  name: "egghead-light",
  type: "light",
  colors: {
    "editor.background": "#f6edd8",
    "editor.foreground": "#1e2a38",
  },
  settings: [
    { settings: { background: "#f6edd8", foreground: "#1e2a38" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { fontStyle: "italic", foreground: "#94855f" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#5c7a4c" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "variable.other.constant",
        "support.constant",
      ],
      settings: { foreground: "#c28e12" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: "#a05040" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "#7e3c2e" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name"],
      settings: { foreground: "#7e3c2e" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: "#3a6b85" },
    },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.type.property-name",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#43536a" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator"],
      settings: { foreground: "#6b7891" },
    },
    {
      scope: ["entity.name.tag"],
      settings: { foreground: "#a05040" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { fontStyle: "italic", foreground: "#c28e12" },
    },
  ],
};

export const eggheadCodeDark: ThemeRegistration = {
  name: "egghead-dark",
  type: "dark",
  colors: {
    "editor.background": "#101926",
    "editor.foreground": "#ede4d3",
  },
  settings: [
    { settings: { background: "#101926", foreground: "#ede4d3" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { fontStyle: "italic", foreground: "#7d8da3" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#9dbe8d" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "variable.other.constant",
        "support.constant",
      ],
      settings: { foreground: "#e8b229" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: "#c2664e" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "#d98a73" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name"],
      settings: { foreground: "#f7c948" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
      ],
      settings: { foreground: "#a8d4e2" },
    },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.type.property-name",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#9aabc0" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator"],
      settings: { foreground: "#7d8da3" },
    },
    {
      scope: ["entity.name.tag"],
      settings: { foreground: "#c2664e" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { fontStyle: "italic", foreground: "#e8b229" },
    },
  ],
};
