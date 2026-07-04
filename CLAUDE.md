# SonicNoteGeek-Obsidian

Obsidian plugin for SonicNote audio transcription and intelligent summarization. TypeScript + esbuild.

## Project structure

```
SonicNoteGeek-Obsidian/
├── main.ts                       # Plugin entry point
├── main.js                       # Built bundle (esbuild)
├── manifest.json                 # Plugin manifest
├── styles.css                    # Plugin styles
├── src/
│   ├── types.ts                  # All type definitions
│   ├── settings.ts               # Plugin settings tab
│   ├── view.ts                   # Side panel view (UI, toolbar, AI chat)
│   ├── modal.ts                  # Processing wizard modal
│   ├── processor.ts              # Audio processing pipeline
│   ├── templates.ts              # Built-in summarization templates
│   ├── sync/
│   │   ├── types.ts              # Sync type definitions
│   │   ├── api.ts                # SonicNote API client
│   │   ├── sync.ts               # Sync orchestration logic
│   │   ├── settings.ts           # Sync settings UI
│   │   └── formatter.ts          # Output formatting
│   └── utils/
│       ├── mp3-extractor.ts      # MP3 link extraction
│       ├── output-generator.ts   # Markdown output generation
│       ├── model-list.ts         # LLM model selector modal
│       ├── asr-model-list.ts     # ASR model selector modal
│       ├── asr-guide.ts          # ASR protocol guide modal
│       └── voiceprint-guide.ts   # Voiceprint guide modal
└── docs/
    ├── SonicNoteGeek-功能说明.md   # Chinese user manual
    └── OpenAI_ASR_GUIDE.md       # OpenAI ASR interface spec
```

## Build / Run

- `npm run build` — production build (tsc + esbuild)
- `npm run dev` — watch mode
- Deploy: copy `main.js`, `styles.css`, `manifest.json` to `~/Documents/Obsidian/.obsidian/plugins/SonicNoteGeek/`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
