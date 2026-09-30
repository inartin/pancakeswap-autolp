import { and, asc, eq, lt } from 'drizzle-orm';
import { calculateMeteoraEarnings } from './earnings.js';

// Inject storage to keep offline tests away from the application's database.
export function createMeteoraEarningsStore(db, table) {
    return function observe(snapshot) {
        const { amount0Human, amount1Human, currentPrice, ...row } = snapshot;
        // Synchronous SQLite transaction also serializes refreshes and background observations.
        return db.transaction(tx => {
            const samples = tx.select().from(table)
                .where(eq(table.position_address, row.position_address))
                .orderBy(asc(table.recorded_at)).all();
            const previous = samples.at(-1);
            if (!previous || row.recorded_at - previous.recorded_at >= 30000) {
                tx.insert(table).values(row).run();
                samples.push(row);
            }
            tx.delete(table).where(and(
                eq(table.position_address, row.position_address),
                lt(table.recorded_at, row.recorded_at - 30 * 60000)
            )).run();
            // Include this refresh for the display even if it is too soon to persist another sample.
            const displaySamples = previous && row.recorded_at > previous.recorded_at && samples.at(-1) !== row
                ? [...samples, row] : samples;
            return calculateMeteoraEarnings(displaySamples, row.recorded_at);
        });
    };
}
