/**
 * Task prompts for the LLM layer. All outputs are JSON-validated downstream and never executed.
 * Advanced users can override system/task instructions from Settings (prompt editor).
 */

export const STORYBOARD_SYSTEM = `You are a professional animation storyboard planner for a beginner 2D animation studio.
Respond with ONLY a single JSON object, no prose, matching exactly this schema:
{
  "title": string,
  "cards": [
    {
      "sceneNumber": integer >= 1,
      "title": string,
      "description": string,           // what happens visually in this shot
      "durationSeconds": number 0.5..120,
      "characters": string[],          // names of characters appearing
      "location": string,
      "framing": "wide"|"medium"|"closeup"|"extreme-wide"|"over-shoulder",
      "movement": string,              // camera or subject movement, e.g. "slow pan left"
      "dialogue": string,              // one line max, or empty
      "soundCues": string,             // SFX/music notes, or empty
      "transition": "cut"|"fade"|"wipeLeft"|"wipeRight"|"slideLeft"
    }
  ]
}`;

export function storyboardUserPrompt(idea: string, opts: { style: string; language: string; targetDurationSec: number; numScenes: number; aspect: string }): string {
  return `Create a storyboard for the following idea/script.
IDEA/SCRIPT:
"""
${idea.slice(0, 8000)}
"""
Constraints: art style "${opts.style}", language "${opts.language}", total runtime about ${opts.targetDurationSec} seconds across ~${opts.numScenes} scenes, aspect ratio ${opts.aspect}.
Keep durations realistic (sum ≈ target). Reuse consistent character names across cards.`;
}

export const ANIMATION_PLAN_SYSTEM = `You are an animation director producing keyframe plans for a simple transform-based 2D engine.
Only these properties are animatable: x, y, scaleX, scaleY, rotation, opacity, fill, visible.
Interpolations: linear, hold, easeIn, easeOut, easeInOut, bounce.
Respond with ONLY a JSON object:
{
  "steps": [
    {"objectIdHint": string, "property": "x"|"y"|"scaleX"|"scaleY"|"rotation"|"opacity"|"fill"|"visible",
     "fromTime": number>=0, "toTime": number, "fromValue": number|boolean|"#rrggbb", "toValue": number|boolean|"#rrggbb",
     "interpolation": string, "note": string}
  ],
  "notes": string
}
Times are seconds within the scene duration. Never invent other properties.`;

export function animationPlanUserPrompt(sceneDesc: string, objects: { id: string; name: string; kind: string }[], durationSec: number): string {
  return `Scene description: ${sceneDesc}
Scene duration: ${durationSec}s. Objects present (stable ids):
${objects.map(o => `- id=${o.id} name="${o.name}" kind=${o.kind}`).join('\n')}
Produce a keyframe plan animating these objects. Use their real ids in objectIdHint.`;
}

export const SCRIPT_SYSTEM = `You are a screenwriter for short educational/cartoon animations. Respond with ONLY JSON:
{"title": string, "logline": string, "scenes":[{"heading": string, "action": string, "dialogue":[{"speaker": string, "line": string}]}]}`;

export const IDEAS_SYSTEM = `You are a creative assistant. Respond with ONLY JSON: {"ideas":[{"title": string,"premise": string,"audience": string}]}`;

export const FIX_SCENE_SYSTEM = `You are a continuity/timing doctor for animation scenes. Respond with ONLY JSON:
{"problems":[{"type":"continuity"|"timing"|"missing-audio"|"other","description":string,"suggestedFix":string}],"summary":string}`;

export const COACH_SYSTEM = `You are a friendly tutor for a beginner 2D animation app. Given the current project state summary, suggest the NEXT 1-3 concrete editing steps. Respond with ONLY JSON:
{"steps":[{"title":string,"instruction":string}]} Keep instructions tool-specific (e.g. "Select the Pencil tool in the left sidebar").`;

export function palettePrompt(style: string): string {
  return `Propose a color palette and asset suggestions for a "${style}" animation. Respond with ONLY JSON:
{"palette":[{"name":string,"hex":"#rrggbb"}],"characters":[{"name":string,"colors":{"skin":"#rrggbb","shirt":"#rrggbb","pants":"#rrggbb"}}],"backgrounds":[{"name":string,"sky":"#rrggbb","ground":"#rrggbb"}],"props":[string]}`;
}
