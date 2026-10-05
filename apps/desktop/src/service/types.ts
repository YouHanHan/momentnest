export interface Library {id:string;name:string;path:string;enabled:boolean}
export interface ScanRoot {id:string;path:string;state:string;count:number;error:string;scannedAt:string|null;enabled:boolean}
export interface Device {id:string;name:string;tokenHash:string;createdAt:string;revoked:boolean}
export interface Batch {id:string;deviceId:string;libraryId:string;mode:'capture'|'upload'|'manual';uploadDate:string;manualDate:string|null;createdAt:string}
export interface Receipt {id:string;receiverId:string;libraryId:string;hash:string;size:number;relativePath:string;filename:string;savedAt:string;captureDate?:string|null;creationDate?:string|null;kind?:'photo'|'video';source?:'phone'|'folder';batchId?:string}
export interface UploadSession {id:string;deviceId:string;clientKey:string;batchId:string;libraryId:string;hash:string;size:number;filename:string;relativePath:string;archiveDate:string;dateSource:string;offset:number;state:'receiving'|'committing'|'complete'|'failed'|'cancelled';error:string;updatedAt:string;receipt?:Receipt;captureDate?:string|null;creationDate?:string|null;kind?:'photo'|'video'}
export interface Location {root:string;path:string;hash:string;size:number;mtime:number}
