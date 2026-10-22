type Props = { family: string; className?: string }

export default function ConsoleArt({ family, className = '' }: Props) {
  return <svg className={`console-art ${className}`} viewBox="0 0 200 120" fill="none" aria-hidden="true">
    <ellipse cx="100" cy="104" rx="65" ry="6" fill="#000" opacity=".16" />
    {family === 'nes' && <>
      <path d="M40 43 63 29h94v56l-20 16H40z" fill="#89978d" />
      <path d="M40 43h97v58H40z" fill="#d0d8cb" /><path d="m137 43 20-14v56l-20 16z" fill="#9ba89d" />
      <path d="m40 43 23-14h94l-20 14z" fill="#e0e5d8" /><path d="M103 43h21v58h-21z" fill="#3c5145" />
      <path d="M49 53h43v21H49z" fill="#b0bbae" /><path d="M52 56h37v3H52z" fill="#6b7c6c" />
      <rect x="48" y="85" width="13" height="6" rx="1" fill="#50694f" /><rect x="66" y="85" width="13" height="6" rx="1" fill="#7b9277" />
      <path d="m128 34 18-1-6 4h-18z" fill="#65796a" />
    </>}
    {family === 'snes' && <>
      <path d="m38 55 25-22h85l20 25v30l-23 14H55L38 87z" fill="#91969e" />
      <path d="m38 55 25-22h85l20 25-23 16H55z" fill="#d4d5d4" /><path d="M55 74h90v28H55z" fill="#b5b9bb" />
      <path d="m72 46 7-8h55l8 8-6 10H68z" fill="#9a9baa" /><path d="M82 41h44v4H82z" fill="#555b68" />
      <rect x="72" y="63" width="20" height="9" rx="2" fill="#8f8aaf" /><rect x="111" y="63" width="20" height="9" rx="2" fill="#77749b" />
      <rect x="73" y="85" width="19" height="8" rx="2" fill="#52605b" /><rect x="106" y="85" width="19" height="8" rx="2" fill="#52605b" />
    </>}
    {family === 'gb' && <g transform="rotate(-12 100 61)">
      <path d="M72 12h57a8 8 0 0 1 8 8v75a14 14 0 0 1-14 14H72a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8Z" fill="#d3d7b8" />
      <rect x="73" y="22" width="56" height="46" rx="6" fill="#76867a" /><rect x="82" y="30" width="38" height="29" rx="1" fill="#9dab78" />
      <path d="M82 77h7v7h7v7h-7v7h-7v-7h-7v-7h7z" fill="#3b5143" />
      <circle cx="122" cy="80" r="5" fill="#67765a" /><circle cx="111" cy="89" r="5" fill="#67765a" />
      <path d="m98 101 6-3m4 3 6-3" stroke="#7f8d74" strokeWidth="3" strokeLinecap="round" />
    </g>}
    {family === 'gba' && <g transform="rotate(-8 100 65)">
      <path d="M48 35q-20 0-22 28t20 29h108q23-1 21-29t-23-28z" fill="#8798bf" stroke="#b0bbd8" strokeWidth="2" />
      <rect x="65" y="39" width="72" height="50" rx="5" fill="#344a50" /><rect x="72" y="45" width="58" height="36" rx="2" fill="#98b8a7" />
      <path d="M43 50h7v9h9v7h-9v9h-7v-9h-9v-7h9z" fill="#d0d9d7" /><circle cx="158" cy="55" r="6" fill="#cad3d8" /><circle cx="146" cy="68" r="6" fill="#cad3d8" />
      <path d="M146 82h6m-99 1h5" stroke="#4b6382" strokeWidth="3" strokeLinecap="round" />
    </g>}
    {family === 'megadrive' && <>
      <path d="m35 57 25-23h93l17 26v28l-24 14H50L35 88z" fill="#344540" />
      <path d="m35 57 25-23h93l17 26-24 15H50z" fill="#50615c" /><ellipse cx="104" cy="55" rx="40" ry="18" fill="#2a3b35" stroke="#738279" strokeWidth="2" />
      <path d="M81 51h46v5H81z" fill="#172a20" /><path d="M61 39h17M50 69h17" stroke="#8e9e91" strokeWidth="3" /><circle cx="143" cy="64" r="5" fill="#91a69a" />
      <rect x="65" y="87" width="22" height="8" rx="3" fill="#172a20" /><rect x="104" y="87" width="22" height="8" rx="3" fill="#172a20" />
    </>}
    {family === 'psx' && <>
      <path d="m37 48 28-19h83l22 28v31l-25 14H51L37 88z" fill="#a1afa5" />
      <path d="m37 48 28-19h83l22 28-25 17H51z" fill="#d6ddd3" /><ellipse cx="106" cy="51" rx="33" ry="21" fill="#b8c4b8" stroke="#8e9d91" strokeWidth="1.5" />
      <path d="m102 42 7-1v15l-7 1z" fill="#65816b" /><path d="m100 57 13-4 6 2-14 5z" fill="#859b75" />
      <ellipse cx="59" cy="52" rx="8" ry="5" fill="#adbdac" /><ellipse cx="152" cy="58" rx="7" ry="5" fill="#adbdac" />
      <rect x="65" y="84" width="25" height="8" rx="2" fill="#6d8272" /><rect x="105" y="84" width="25" height="8" rx="2" fill="#6d8272" />
    </>}
  </svg>
}
