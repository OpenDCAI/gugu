import { reaction } from 'mobx'
import { useEffect, useState } from 'react'
import { displayNameOf } from '@shared/extensions/file-openers'
import { chatClaimantHere } from './chatClaimant'

/**
 * The words of a link to a group's file, read the way the file list reads that file (摩擦单 F39): a link written as the
 * file's name — the folder App's tools, `gugu.send`'s `about` — shows it without the suffix an App here claims it
 * by (`guess` for `guess.draw-guess.json`), the whole name on hover. Only what shows changes: the link and the words in
 * the message stay as written; words no App here claims as a file show as they are. By the Apps on this device, as the
 * list is — so two people may read one message differently.
 */
export function GroupFileName({ name }: { name: string }) {
  const [shown, setShown] = useState<string | null>(null)
  useEffect(
    () =>
      reaction(
        () => {
          const claim = chatClaimantHere(name)
          return claim ? displayNameOf(name, claim.suffix) : null
        },
        setShown,
        { fireImmediately: true },
      ),
    [name],
  )
  return shown !== null && shown !== name ? <span title={name}>{shown}</span> : <>{name}</>
}
