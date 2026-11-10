import { useId } from 'react';

/** Small vector illustrations stay sharp at every Windows display scale. */
export function BotAppArtwork({ app }: { app: 'browser' | 'assets' }) {
  const id = useId().replaceAll(':', '');
  return <svg className="bot-app-artwork" viewBox="0 0 88 88" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id={id + 'sky'} x1="22" y1="12" x2="65" y2="76" gradientUnits="userSpaceOnUse"><stop stopColor="#A9ECFF" /><stop offset=".46" stopColor="#6098FF" /><stop offset="1" stopColor="#6656DA" /></linearGradient>
      <linearGradient id={id + 'edge'} x1="25" y1="18" x2="67" y2="73" gradientUnits="userSpaceOnUse"><stop stopColor="#F1FBFF" /><stop offset="1" stopColor="#A8ADFF" /></linearGradient>
      <linearGradient id={id + 'gold'} x1="25" y1="23" x2="61" y2="74" gradientUnits="userSpaceOnUse"><stop stopColor="#FFEFC0" /><stop offset=".45" stopColor="#EFC480" /><stop offset="1" stopColor="#BC8A66" /></linearGradient>
      <linearGradient id={id + 'violet'} x1="29" y1="14" x2="62" y2="69" gradientUnits="userSpaceOnUse"><stop stopColor="#DAD4FF" /><stop offset="1" stopColor="#8E88D9" /></linearGradient>
      <linearGradient id={id + 'paper'} x1="36" y1="20" x2="61" y2="58" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF" /><stop offset="1" stopColor="#DBE9FF" /></linearGradient>
      <radialGradient id={id + 'shine'} cx="0" cy="0" r="1" gradientTransform="translate(33 27) rotate(50) scale(34 26)" gradientUnits="userSpaceOnUse"><stop stopColor="white" stopOpacity=".7" /><stop offset="1" stopColor="white" stopOpacity="0" /></radialGradient>
    </defs>
    {app === 'browser' ? <>
      <ellipse cx="44" cy="76" rx="23" ry="4" fill="#6564AB" opacity=".12" />
      <circle cx="43" cy="42" r="28" fill={'url(#' + id + 'sky)'} stroke={'url(#' + id + 'edge)'} strokeWidth="1.5" />
      <circle cx="43" cy="42" r="25" stroke="white" strokeOpacity=".18" />
      <ellipse cx="43" cy="42" rx="12" ry="27" stroke="white" strokeOpacity=".6" strokeWidth="1.3" transform="rotate(-24 43 42)" />
      <path d="M18 33c10 6 31 14 51 16M24 22c12 9 26 14 43 17M20 48c9 9 25 14 39 16" stroke="white" strokeOpacity=".48" strokeWidth="1.2" />
      <circle cx="43" cy="42" r="27" fill={'url(#' + id + 'shine)'} />
      <path d="M13 54c-2 5 0 9 6 10 12 3 35-4 51-16 7-6 11-12 9-16-1-3-5-4-10-3" stroke={'url(#' + id + 'edge)'} strokeWidth="2" strokeLinecap="round" />
      <path d="m63 54 14-6-6 19-3-9-5-4Z" fill="#F7F4FF" stroke="#8E88D9" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="m69 58 8-10" stroke="#A2A0DB" strokeLinecap="round" />
      <path d="m18 17 1.5 3.5L23 22l-3.5 1.5L18 27l-1.5-3.5L13 22l3.5-1.5L18 17Z" fill="#A7B4EF" />
      <circle cx="73" cy="20" r="2" fill="#C5BCEB" />
    </> : <>
      <ellipse cx="44" cy="77" rx="25" ry="4" fill="#8D7198" opacity=".12" />
      <path d="M18 34c0-3 2-5 5-5h13l5 5h24c3 0 5 2 5 5v28c0 4-3 6-6 6H24c-4 0-6-2-6-6V34Z" fill="#B49ACB" stroke="#EEE5F5" strokeWidth="1.3" />
      <rect x="28" y="21" width="25" height="36" rx="4" fill={'url(#' + id + 'violet)'} stroke="#F0EBFF" strokeWidth="1.3" transform="rotate(-15 28 21)" />
      <rect x="38" y="19" width="25" height="36" rx="4" fill={'url(#' + id + 'paper)'} stroke="#BCC9E6" strokeWidth="1.2" transform="rotate(12 38 19)" />
      <path d="m41 37 6-5 3 4 4-2 3 7-17-3Z" fill="#A7B9E8" /><circle cx="53" cy="29" r="2.2" fill="#D3B98F" />
      <path d="M17 44c0-3 2-5 5-5h43c4 0 6 3 5 6l-4 23c-.5 3-3 5-6 5H23c-3 0-5-2-5-5l-1-24Z" fill={'url(#' + id + 'gold)'} stroke="#FAEACB" strokeWidth="1.4" />
      <path d="M21 44h43M22 67h38" stroke="#FFF9E9" strokeOpacity=".65" strokeLinecap="round" />
      <path d="m45 47 10 6v11l-10 6-10-6V53l10-6Z" fill="#A68DAD" stroke="#FFF0DA" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="m35 53 10 6 10-6M45 59v11" stroke="#F6DCC4" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="m72 16 1.5 4.5L78 22l-4.5 1.5L72 28l-1.5-4.5L66 22l4.5-1.5L72 16Z" fill="#C8B7DB" />
      <circle cx="21" cy="17" r="2" fill="#E4CCA2" />
    </>}
  </svg>;
}
