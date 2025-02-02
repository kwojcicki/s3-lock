import { GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { S3Lock } from "./index";

const locker = new S3Lock(new S3Client({
    region: 'us-east-1'
}));

const id = Date.now();
const commonProps = {
    bucket: "test-s3-locking-cas",
    key: `${id}`
}

const existenceLock = async () => {
    console.log("Starting existence example");

    const lock = await locker.acquireLock(commonProps);
    try {
        // attempting to obtain already acquired lock, should fail
        await locker.acquireLock(commonProps);
        throw new Error("Should not reach this");
    } catch (e) {
        console.log(e);
        if (e.message === "Should not reach this") throw e;
    }

    await lock.release(JSON.stringify({ locked: false }));
}

const compareAndSwapLock = async () => {
    console.log("Starting compare and swap example");

    const conditional = async (props: GetObjectCommandOutput) => {
        const lockBody = JSON.parse(await props.Body!.transformToString());
        console.log(`Conditional: ${Boolean(!lockBody.locked && lockBody.testConditional)} and ${JSON.stringify(lockBody)}`);
        return Boolean(!lockBody.locked && lockBody.testConditional);
    }

    const compareAndSwapCommonProps = {
        ...commonProps, conditional, maxAttempts: 2, timeout: 100
    }

    let lock = await locker.acquireLock({
        ...compareAndSwapCommonProps, conditional: async () => true, generateBody: async () => JSON.stringify({
            locked: true,
            testConditional: true
        })
    });

    try {
        // attempting to obtain already acquired lock, should fail
        await locker.acquireLock(compareAndSwapCommonProps);
        throw new Error("Should not reach this");
    } catch (e) {
        console.log(e);
        if (e.message === "Should not reach this") throw e;
    }

    await lock.release(JSON.stringify({ locked: false, testConditional: true }));

    lock = await locker.acquireLock(compareAndSwapCommonProps)

    // flipping truthness testConditional to fail the reacquire
    await lock.release(JSON.stringify({ locked: false, testConditional: false }));

    try {
        await locker.acquireLock(compareAndSwapCommonProps)
        throw new Error("Should not reach this");
    } catch (e) {
        console.log(e);
        if (e.message === "Should not reach this") throw e;
    }
}

export const handler = async (_event: any, _context: any) => {

    await existenceLock();
    await compareAndSwapLock();

    return "ok";
};