export interface PostgresParameter {
    name: string;
    value: string | Date | number | boolean | Array<any> | null;
}
