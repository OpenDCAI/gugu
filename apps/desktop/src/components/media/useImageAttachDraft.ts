import { useCallback, useEffect, useRef, useState } from 'react'

export interface ImageAttachDraftItem { id: string; file: File; previewUrl: string }
export interface ImageAttachDraftState {
  images: ImageAttachDraftItem[]
  addFiles: (files: Iterable<File>) => void
  removeImage: (id: string) => void
  clearImages: () => void
  uploadImages: <T>(upload: (file: File) => Promise<T>) => Promise<T[]>
}
export interface ImageAttachDraftOptions { maxImages?: number }
function revokeImages(images: ImageAttachDraftItem[]): void {
  images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
}
export function useImageAttachDraft({ maxImages = 9 }: ImageAttachDraftOptions = {}): ImageAttachDraftState {
  const [images, setImages] = useState<ImageAttachDraftItem[]>([])
  const imagesRef = useRef<ImageAttachDraftItem[]>([])
  const commit = useCallback((next: ImageAttachDraftItem[]) => {
    imagesRef.current = next
    setImages(next)
  }, [])
  const addFiles = useCallback((files: Iterable<File>) => {
    const available = Math.max(0, maxImages - imagesRef.current.length)
    if (available === 0) return
    const additions = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, available)
      .map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }))
    if (additions.length > 0) commit([...imagesRef.current, ...additions])
  }, [commit, maxImages])
  const removeImage = useCallback((id: string) => {
    const removed = imagesRef.current.find((image) => image.id === id)
    if (!removed) return
    URL.revokeObjectURL(removed.previewUrl)
    commit(imagesRef.current.filter((image) => image.id !== id))
  }, [commit])
  const clearImages = useCallback(() => {
    revokeImages(imagesRef.current)
    commit([])
  }, [commit])
  const uploadImages = useCallback(<T,>(upload: (file: File) => Promise<T>) => {
    const snapshot = [...imagesRef.current]
    return Promise.all(snapshot.map((image) => upload(image.file)))
  }, [])
  useEffect(() => () => {
    revokeImages(imagesRef.current)
    imagesRef.current = []
  }, [])
  return { images, addFiles, removeImage, clearImages, uploadImages }
}
