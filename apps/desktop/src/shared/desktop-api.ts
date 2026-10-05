export interface AppInfo {
  version: string
  platform: string
}

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>
  selectFolders(multiple: boolean): Promise<string[]>
  getState(): Promise<ReceiverState>
  setCurrentLibrary(id: string): Promise<void>
  addDirectories(kind: 'library' | 'root'): Promise<void>
  toggleDirectory(kind: 'library' | 'root', id: string, enabled: boolean): Promise<void>
  scan(): Promise<void>
  setAccepting(value: boolean): Promise<void>
  createPairing(): Promise<PairingInfo>
  revokeDevice(id: string): Promise<void>
  revealFile(id: string): Promise<void>
  previewFile(id: string): Promise<string>
  getFamilyState(libraryId?: string): Promise<FamilyState>
  getJobWarnings(jobId: string, page?: number, libraryId?: string): Promise<ProcessingWarningPage>
  queryMedia(query: MediaQuery): Promise<MediaPage>
  querySimilarFaces(query: SimilarFaceQuery): Promise<SimilarFacePage>
  scanMedia(libraryId?: string): Promise<void>
  prepareImport(rootId: string, mode: 'index' | 'copy', libraryId?: string): Promise<ImportPlan>
  executeImport(planId: string): Promise<void>
  mediaUrl(assetId: string, thumbnail?: boolean, libraryId?: string): Promise<string>
  revealMedia(assetId: string, libraryId?: string): Promise<void>
  saveBaby(baby: BabyProfile, matchScope?: 'library' | 'all'): Promise<void>
  setBabyMembership(babyId: string, assetIds: string[], included: boolean): Promise<BrowseMutation>
  setMediaDate(assetId: string, date: string): Promise<void>
  setFavorite(assetId: string, favorite: boolean): Promise<BrowseMutation>
  analyzeFaces(libraryId?: string, retryOnlyFailed?: boolean): Promise<void>
  supplementFaces(libraryId?: string): Promise<void>
  rebuildFaceIndex(libraryId: string): Promise<void>
  namePerson(personId: string, name: string): Promise<void>
  mergePersons(sourceId: string, targetId: string, libraryId: string): Promise<void>
  preparePersonGrouping(libraryId: string): Promise<PersonGroupingPreview>
  applyPersonGrouping(planId: string, libraryId: string, sourceIds?: string[]): Promise<number>
  undoPersonGrouping(token: string, libraryId: string): Promise<number>
  setBabyReference(babyId: string, assetId: string, faceId: string): Promise<void>
  matchBaby(babyId: string, libraryId?: string, scope?: 'library' | 'all'): Promise<BabyMatchResult>
  previewWatermark(assetId: string, options: WatermarkOptions, libraryId?: string): Promise<WatermarkResult>
  exportWatermark(assetIds: string[], options: WatermarkOptions, libraryId?: string): Promise<WatermarkResult[]>
}

export interface PairingInfo {payload:string;qr:string;expiresAt:number;addresses:string[]}
export interface ReceiverState {
  currentLibraryId: string | null; currentLibraryAvailable?: boolean
  receiverId:string;name:string;port:number;addresses:string[];accepting:boolean;scanning:boolean;savedCount:number
  libraries:{id:string;name:string;path:string;enabled:boolean}[]
  roots:{id:string;path:string;state:string;count:number;error:string;scannedAt:string|null;enabled:boolean}[]
  devices:{id:string;name:string;createdAt:string;revoked:boolean}[]
  sessions:{id:string;batchId?:string;libraryId?:string;filename:string;size:number;offset:number;state:string;error:string;updatedAt:string;archiveDate:string;receipt?:{id:string;libraryId:string;relativePath:string;savedAt:string}}[]
  files:{id:string;filename:string;size:number;relativePath:string;libraryId:string;savedAt:string;batchId?:string}[]
}
import type { BabyMatchResult, BabyProfile, BrowseMutation, FamilyState, ImportPlan, MediaPage, MediaQuery, PersonGroupingPreview, ProcessingWarningPage, SimilarFacePage, SimilarFaceQuery, WatermarkOptions, WatermarkResult } from './family'
