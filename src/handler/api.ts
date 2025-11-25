import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import {
    GetMachineRequestModel,
    HttpResponseCode,
    MachineResponseModel,
    RequestMachineRequestModel,
    RequestModel,
    StartMachineRequestModel
} from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";

/**
 * Handles API requests for machine operations.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    private table = MachineStateTable.getInstance();
    private idp = IdentityProviderClient.getInstance();
    private smart = SmartMachineClient.getInstance();

    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

private checkToken(token: string) {
    const isValid = this.idp.validateToken(token);
    if (!isValid) {
        throw new Error(
            JSON.stringify({
                statusCode: HttpResponseCode.UNAUTHORIZED,
                message: "Invalid token"
            })
        );
    }
}


    /**
     * POST /machine/request
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        // No findOne() → use listMachinesAtLocation() and filter manually
        const candidates = this.table.listMachinesAtLocation(request.locationId);
        const available = candidates.find(m => m.status === MachineStatus.AVAILABLE);

        if (!available) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        // Update machine state
        this.table.updateMachineStatus(available.machineId, MachineStatus.AWAITING_DROPOFF);
        this.table.updateMachineJobId(available.machineId, request.jobId);

        const updated = this.table.getMachine(available.machineId)!;
        this.cache.put(updated.machineId, updated);

        return { statusCode: HttpResponseCode.OK, machine: updated };
    }

    /**
     * GET /machine/:id
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        const cached = this.cache.get(request.machineId);
        if (cached) {
            return { statusCode: HttpResponseCode.OK, machine: cached };
        }

        // No findById() → use getMachine()
        const fromDb = this.table.getMachine(request.machineId);

        if (!fromDb) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        this.cache.put(request.machineId, fromDb);
        return { statusCode: HttpResponseCode.OK, machine: fromDb };
    }

    /**
     * POST /machine/:id/start
     */
private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
    const machine = this.table.getMachine(request.machineId);

    if (!machine) {
        return { statusCode: HttpResponseCode.NOT_FOUND };
    }

    if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
        return { statusCode: HttpResponseCode.BAD_REQUEST, machine };
    }

    try {
        this.smart.startCycle(machine.machineId);
    } catch (err) {
        // *** FIX: update status to ERROR ***
        this.table.updateMachineStatus(machine.machineId, MachineStatus.ERROR);

        const errorMachine = this.table.getMachine(machine.machineId)!;
        this.cache.put(errorMachine.machineId, errorMachine);

        return {
            statusCode: HttpResponseCode.HARDWARE_ERROR,
            machine: errorMachine
        };
    }

    this.table.updateMachineStatus(machine.machineId, MachineStatus.RUNNING);

    const updated = this.table.getMachine(machine.machineId)!;
    this.cache.put(updated.machineId, updated);

    return { statusCode: HttpResponseCode.OK, machine: updated };
}


    /**
     * Main request router
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMatch) {
            return this.handleGetMachine({
                ...request,
                machineId: getMatch[1]
            } as GetMachineRequestModel);
        }

        const startMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMatch) {
            return this.handleStartMachine({
                ...request,
                machineId: startMatch[1]
            } as StartMachineRequestModel);
        }

        // NEVER return null → change to undefined
        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR };
    }
}
