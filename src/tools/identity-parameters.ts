/** One model-facing public profile shape for staged plans, recruitment and patches. */
import type { MemberIdentityInput } from '../domain/identity-profile.js'
import type { TeamMemberIdentityProfile } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'
import { compilePixelAvatarGrid, type PixelAvatarGrid } from '../domain/pixel-avatar-grid.js'

export const publicIdentitySchema = {
  type: 'object', required: true, additionalProperties: false,
  properties: {
    display_name: { type: 'string' }, profession: { type: 'string' },
    personality: { type: 'string' }, biography: { type: 'string' },
    avatar_saved: { type: 'boolean', required: true },
    missing_fields: { type: 'array', required: true, items: { type: 'string', enum: ['display_name', 'profession', 'personality', 'biography', 'pixel_avatar'] } },
  },
} as const

export function publicIdentity(profile: TeamMemberIdentityProfile = {}) {
  const fields = { display_name: profile.displayName, profession: profile.profession, personality: profile.personality, biography: profile.biography }
  const missing: Array<keyof typeof fields | 'pixel_avatar'> = (Object.keys(fields) as Array<keyof typeof fields>).filter(key => fields[key] === undefined)
  if (profile.pixelAvatarSvg === undefined) missing.push('pixel_avatar')
  return {
    ...(profile.displayName === undefined ? {} : { display_name: profile.displayName }),
    ...(profile.profession === undefined ? {} : { profession: profile.profession }),
    ...(profile.personality === undefined ? {} : { personality: profile.personality }),
    ...(profile.biography === undefined ? {} : { biography: profile.biography }),
    avatar_saved: profile.pixelAvatarSvg !== undefined,
    missing_fields: missing,
  }
}

export const identityParameters = {
  display_name: { type: 'string', description: 'Public display name, at most 128 code points; preserve user preference/language.' },
  profession: { type: 'string', description: 'Short professional identity or discipline, e.g. 3D character artist. Not Team duties or permission limits. At most 256 code points.' },
  personality: { type: 'string', description: 'Stable behavioral traits, e.g. patient, precise, evidence-minded. Not task steps, current status or access rules. At most 1024 code points.' },
  biography: { type: 'string', description: 'Brief truthful expertise and background. Do not repeat the role or include current tasks, file paths, temporary stages or permission rules. No invented credentials. At most 1024 code points.' },
  pixel_avatar: { type: 'object', additionalProperties: false, description: 'After saving and reading back all four text fields, design your own 32x32 pixel avatar to suit your chosen identity and tastes. Freely choose people, animals, objects or abstract designs; coordinate main/accent colors and contrast. Center a ~24-28px subject; add 1px details; never upscale coarse 8/16px art. Use the palette/rows format below. Do not also supply pixel_avatar_svg.', properties: {
    palette: { type: 'array', required: true, items: { type: 'string' }, description: '1-16 #RRGGBB colors indexed by 0-9/A-F.' },
    rows: { type: 'array', required: true, items: { type: 'string' }, description: 'Exactly 32 strings of 32 pixels each; . is transparent, 0-9/A-F selects a palette entry. Horizontal/vertical runs compile safely to SVG.' },
  } },
  pixel_avatar_svg: { type: 'string', description: 'Same saved-profile prerequisite. Legacy alternative, <=16KB: svg viewBox="0 0 N N" (8<=N<=32) with <=256 self-closing rects using x/y/width/height/fill. Hex colors only, no style/path/scripts/links. Prefer pixel_avatar.' },
} as const

export function identityPatch(args: { display_name?: string; profession?: string; personality?: string; biography?: string; pixel_avatar_svg?: string; pixel_avatar?: PixelAvatarGrid }): MemberIdentityInput {
  if (args.pixel_avatar !== undefined && args.pixel_avatar_svg !== undefined) throw new TeamDomainError('supply pixel_avatar or pixel_avatar_svg, not both', 'TEAM_MEMBER_IDENTITY_INVALID')
  const svg = args.pixel_avatar === undefined ? args.pixel_avatar_svg : compilePixelAvatarGrid(args.pixel_avatar)
  return {
    ...(args.display_name === undefined ? {} : { displayName: args.display_name }),
    ...(args.profession === undefined ? {} : { profession: args.profession }),
    ...(args.personality === undefined ? {} : { personality: args.personality }),
    ...(args.biography === undefined ? {} : { biography: args.biography }),
    ...(svg === undefined ? {} : { pixelAvatarSvg: svg }),
  }
}
