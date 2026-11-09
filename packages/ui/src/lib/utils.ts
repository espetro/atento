import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ClassValue as CV } from 'clsx'

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

export type { CV as ClassValue }
export type WithElementRef<T extends object, Ref = HTMLElement> = T & { ref?: Ref | null }
export type WithoutChild<T extends object> = Omit<T, 'child'>
export type WithoutChildren<T extends object> = Omit<T, 'children'>
export type WithoutChildrenOrChild<T extends object> = Omit<T, 'children' | 'child'>
