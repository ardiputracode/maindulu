import { ArrowUpRight, Heart, Play, Upload } from 'lucide-react'
import type { ConsoleInfo, Game } from '../lib/domain'
import { relativeTime } from '../lib/domain'
import ConsoleArt from './ConsoleArt'

export default function GameCard({ game, consoleInfo, favorite, onFavorite, onOpen, showTime = false }: {
  game: Game; consoleInfo?: ConsoleInfo; favorite: boolean; onFavorite: () => void; onOpen: () => void; showTime?: boolean;
}) {
  return <article className="game-card">
    <div className={`game-cover ${!game.cover ? 'local-cover' : ''}`}>
      <button className="cover-open" onClick={onOpen} aria-label={`Mainkan ${game.title}`}>
        {game.cover ? <img src={game.cover} alt="" loading="lazy" /> : <><ConsoleArt family={consoleInfo?.family || 'nes'} /><span>KENANGAN MILIKMU</span></>}
        <span className="cover-play"><Play size={23} fill="currentColor" /></span>
      </button>
      <span className="game-source">{game.source === 'local' ? 'ROM LOKAL' : 'MAINDULU ORIGINAL'}</span>
      <button className={`favorite-button ${favorite ? 'is-favorite' : ''}`} onClick={onFavorite} aria-label={`${favorite ? 'Hapus' : 'Tambahkan'} ${game.title} ${favorite ? 'dari' : 'ke'} favorit`} aria-pressed={favorite}><Heart size={17} fill={favorite ? 'currentColor' : 'none'} /></button>
    </div>
    <div className="game-info"><div><span className="game-console">{consoleInfo?.shortName || game.consoleId}</span><button className="game-name" onClick={onOpen}>{game.title}</button><span className="game-detail">{showTime ? relativeTime(game.lastPlayed) : game.source === 'local' ? 'Pilih kembali ROM untuk bermain' : 'Homebrew · tangkap bintang, pulang tenang'}</span></div><button className="icon-button play-arrow" onClick={onOpen} aria-label={`Buka ${game.title}`}>{game.source === 'local' ? <Upload size={19} /> : <ArrowUpRight size={22} />}</button></div>
  </article>
}
