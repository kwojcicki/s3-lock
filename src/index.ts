import { GetObjectCommand, GetObjectCommandOutput, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export class LockNotAcquiredError extends Error {
    constructor(message: string = 'Failed to acquire lock') {
        super(message);
        this.name = 'LockNotAcquiredError';
        Object.setPrototypeOf(this, LockNotAcquiredError.prototype);
    }
}

export interface CommonAcquireLock {
    bucket: string,
    key: string,
    // the default implementation is to write { locked: true } at defaultGenerateBody
    generateBody?: () => Promise<string>
}

/**
 * Attempt to acquire a lock via overwriting an object in bucket and name of key.
 * 
 * First the object with that key name will be pulled and its etag stored.
 * The contents of the object will be compared using the conditional. 
 * If true the object will be overwritten with an If-Match on the etag.
 * This process will repeat maxAttempt times with a timeout delay between each
 * attempt.
 */
export interface AcquireCompareAndSwapLock extends CommonAcquireLock {
    // a default condition of checking { locked: false } can be found at defaultConditional
    conditional: (props: GetObjectCommandOutput) => Promise<boolean>
    maxAttempts?: number
    timeout?: number
};

export interface LockedCompareAndSwapLock {
    release: (newBody: string) => Promise<boolean>
}

/**
 * Attempt to acquire a lock via writing an object in bucket and name of key.
 * 
 * The If-None-Match is utilized to verified two clients do not both have their
 * writes succeed
 */
export interface AcquireExistenceLock extends CommonAcquireLock {
};

export interface LockedExistenceLock {
    release: (newBody: string) => Promise<boolean>
}

export type InitializeLockFile = {
    bucket: string,
    key: string
}

export const defaultConditional = async (props: GetObjectCommandOutput): Promise<boolean> => {
    return !JSON.parse(await props.Body?.transformToString() ?? "{}")?.locked;
}

const defaultGenerateBody = async (): Promise<string> => {
    return JSON.stringify({ locked: true });
}

const isCompareAndSwapLock = (lock: AcquireExistenceLock | AcquireCompareAndSwapLock): lock is AcquireCompareAndSwapLock => {
    return 'conditional' in lock;
}

export class S3Lock {
    private s3Client: S3Client;
    public constructor(s3Client: S3Client) {
        this.s3Client = s3Client;
    }

    public async initializeLockFile(props: InitializeLockFile) {
        const { bucket, key } = props;
        try {
            await this.s3Client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: JSON.stringify({ locked: false })
            }));
        } catch (error) {
            if (error instanceof Error && 'name' in error && error.name === 'PreconditionFailed') {
                throw new LockNotAcquiredError();
            }
            throw error;
        }
    }

    /**
     * Attempts to acquire a lock either via a compare-and-swap methodology or an existence check.
     * Throws LockNotAcquiredError if the lock could not be acquired.
     */
    public async acquireLock(props: AcquireCompareAndSwapLock): Promise<LockedCompareAndSwapLock>;
    public async acquireLock(props: AcquireExistenceLock): Promise<LockedExistenceLock>;
    public async acquireLock(props: AcquireCompareAndSwapLock | AcquireExistenceLock): Promise<any> {
        const { bucket, key } = props;
        const generateBody = props.generateBody ?? defaultGenerateBody;

        if (isCompareAndSwapLock(props)) {

            let attempt = props.maxAttempts ?? 5;
            const timeout = props.timeout ?? 5000;
            const conditional = props.conditional ?? defaultConditional;

            while (attempt-- > 0) {
                console.log(`Compare and swap lock: Writing to ${bucket} ${key}`);
                const getLatestETag = await this.s3Client.send(new GetObjectCommand({
                    Bucket: bucket,
                    Key: key
                }))

                if (!await conditional(getLatestETag)) {
                    await new Promise(r => setTimeout(r, timeout));
                    continue;
                }

                try {
                    const resp = await this.s3Client.send(new PutObjectCommand({
                        Bucket: bucket,
                        Key: key,
                        IfMatch: getLatestETag.ETag,
                        Body: await generateBody()
                    }));
                    console.log(`Compare and swap Lock acquired`);

                    return {
                        release: async (newBody: string) => {
                            await this.s3Client.send(new PutObjectCommand({
                                Bucket: bucket,
                                Key: key,
                                IfMatch: resp.ETag,
                                Body: newBody
                            }));
                        }
                    }
                } catch (error) {
                    if (error instanceof Error && 'name' in error && error.name === 'PreconditionFailed') {
                        // another client acquired the lock before us, wait timeout and try again
                        await new Promise(r => setTimeout(r, timeout));
                        continue;
                    }
                    throw error;
                }
            }

            // lock could not be acquired within max attempts
            throw new LockNotAcquiredError();
        } else {

            try {
                console.log(`Existence Lock: Writing to ${bucket} ${key}`);
                const resp = await this.s3Client.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    IfNoneMatch: "*",
                    Body: await generateBody()
                }));

                console.log(`Existence Lock acquired`);

                return {
                    release: async (newBody: string) => {
                        await this.s3Client.send(new PutObjectCommand({
                            Bucket: bucket,
                            Key: key,
                            IfMatch: resp.ETag,
                            Body: newBody
                        }));
                    }
                }
            } catch (error) {
                if (error instanceof Error && 'name' in error && error.name === 'PreconditionFailed') {
                    throw new LockNotAcquiredError();
                }
                throw error;
            }
        }
    }
}
